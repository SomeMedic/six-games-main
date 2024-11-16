import {Chess} from "chess.js";
import config from "config";
import debug from "debug";
import {DateTime} from "luxon";
import ShortUniqueId from "short-unique-id";
import {DisconnectReason} from "socket.io";
import {EventNames, EventParams} from "socket.io/dist/typed-events.js";

import {PlayedGame} from "./Database.js";
import {
    Color,
    GameResolution,
    GameRules,
    GameState,
    GameStatus,
    Member,
    Move,
    Room,
    ServerToClientEvents,
    TimerState,
    User,
} from "./DataModel.js";
import {AlreadyConnectedError, IllegalMoveError} from "./Errors.js";
import {Socket} from "./GameServer.js";
import {PausableTimer} from "./PausableTimer.js";
import {catchErrors} from "./SocketErrorHandler.js";
import {TypedEventEmitter} from "./TypedEventEmitter.js";

const UID = new ShortUniqueId({length: 24});

const log = debug("GameServer:ServerRoom");

interface MemberSession {
    member: Member;
    socket: Socket | null;
    joined: DateTime;
    disconnectTimer?: PausableTimer | null;
}

interface ServerRoomEvents {
    connectedUsersChange: [];
    gameStatusChange: [];
    destroy: [];
}

//Room will be destroyed after 3 minutes if no one is connected
export const InactivityTimeout = config.get<number>("gameServer.inactivityTimeout") * 1000;

//If user disconnects mid-game for more than 1 minute, he automatically looses
export const DisconnectTimeout = config.get<number>("gameServer.disconnectTimeout") * 1000;

export class ServerRoom extends TypedEventEmitter<ServerRoomEvents> {
    public readonly id: string;

    public readonly hostID: number;

    public readonly createdDateTime: DateTime;

    public readonly gameRules: GameRules;

    public readonly isFake: boolean;

    protected readonly _gameState: Omit<GameState, "turn" | "pgn" | "timer">;

    protected readonly sessions: {[key: number]: MemberSession};

    protected winnerId: number | undefined;

    private inactivityTimer: PausableTimer;

    public constructor(host: User, gameRules: GameRules, id?: string) {
        super();

        if (id) {
            this.id = id;
        } else {
            this.id = UID.rnd();
        }

        log('Created new room("%s")', this.id);

        this.createdDateTime = DateTime.now();

        this.sessions = {};
        this.sessions[host.id] = {
            member: {
                user: host,
                state: {
                    connected: false,
                    isPlayer: true,
                },
            },
            socket: null,
            joined: this.createdDateTime,
        };

        this.hostID = host.id;
        this.gameRules = gameRules;
        this._gameState = {
            status: GameStatus.NotStarted,
        };

        this.inactivityTimer = new PausableTimer(catchErrors()(this.handleInactivityTimeout));
        this.inactivityTimer.start(InactivityTimeout);

        this.winnerId = 0;

        if (config.get<boolean>("gameServer.fakeRoom.create")) {
            this.isFake = this.id === config.get<string>("gameServer.fakeRoom.id");
        } else {
            this.isFake = false;
        }
    }

    public get gameStatus(): GameStatus {
        return this._gameState.status;
    }

    public get host(): User {
        return this.sessions[this.hostID].member.user;
    }

    public get connectedUsers(): User[] {
        return this.connectedSessions().map((session) => session.member.user);
    }

    public get timer(): TimerState | undefined {
        return;
    }

    public getWinnerId(): User {
        return this.sessions[this.winnerId!].member.user;
    }

    protected setWinnerId(id: number): void {
        if (id === undefined) {
            return;
        }

        this.winnerId = id;
    }

    public readonly gameState = (): GameState => {
        return {
            ...this._gameState,
            turn: 'w' as Color,
            pgn: '',
            timer: this.timer,
        };
    };

    public readonly members = (): Member[] => {
        return Object.values(this.sessions).map((session) => session.member);
    };

    public readonly numberOfConnectedMembers = (): number => {
        return this.connectedSessions().length;
    };

    public readonly isUserPresent = (userID: number): boolean => {
        return Boolean(this.sessions[userID]);
    };

    public readonly isUserConnected = (userID: number): boolean => {
        return Boolean(this.sessions[userID]?.member.state.connected);
    };

    public readonly dto = (): Room => {
        return {
            id: this.id,
            members: this.members(),
            hostID: this.hostID,
            createdTimestamp: this.createdDateTime.toSeconds(),
            gameRules: this.gameRules,
            gameState: this.gameState(),
        };
    };

    public acceptConnection(socket: Socket, user: User): void {
        if (this.isUserConnected(user.id)) {
            throw new AlreadyConnectedError("You can not connect to the same room twice");
        }

        if (this.inactivityTimer.isGoing) {
            this.inactivityTimer.stop();
        }

        if (this.isUserPresent(user.id)) {
            this.sessions[user.id].socket = socket;
            this.sessions[user.id].member.state.connected = true;

            socket.emit("init", this.dto(), user.id);
            this.broadcastExcept(user.id, "memberUpdate", user.id, this.sessions[user.id].member.state);

            log('User(%d) connected to room("%s")', user.id, this.id);
        } else {
            this.sessions[user.id] = {
                member: {
                    user: user,
                    state: {
                        connected: true,
                        isPlayer: false,
                    },
                },
                socket: socket,
                joined: DateTime.now(),
            };

            socket.emit("init", this.dto(), user.id);
            this.broadcastExcept(user.id, "memberJoin", this.sessions[user.id].member);

            log('User(%d) joined room("%s")', user.id, this.id);
        }

        if (this.sessions[user.id].disconnectTimer) {
            this.sessions[user.id].disconnectTimer!.stop();
            this.sessions[user.id].disconnectTimer = undefined;
        }

        socket.on(
            "disconnect",
            catchErrors()((reason: DisconnectReason) => {
                this.handleDisconnect(user.id, reason);
            })
        );
    };

    protected readonly handleInactivityTimeout = (): void => {
        log('room("%s") will be destroyed due to reaching an inactivity timeout', this.id);
        this.emit("destroy");
    };

    protected readonly checkInactivity = (): void => {
        if (this.numberOfConnectedMembers() === 0) {
            if (this.gameStatus === GameStatus.NotStarted) {
                this.inactivityTimer.start(InactivityTimeout);
            } else if (this.gameStatus === GameStatus.Finished) {
                this.emit("destroy");
            }
        }
    };

    protected async saveGame(): Promise<void> {
        if (this._gameState.status !== GameStatus.Finished) {
            throw new Error("Game is not finished yet");
        }
        if (this.isFake) {
            return;
        }

        log('Saving played game in room("%s") to the database', this.id);
    }

    protected async handleDisconnectTimeout(userID: number): Promise<void> {
        log('Player(%d) quit in room("%s")', userID, this.id);
        this._gameState.status = GameStatus.Finished;

        for (const session of Object.values(this.sessions)) {
            session.disconnectTimer?.stop();
        }

        this.emit("gameStatusChange");
        await this.saveGame();
    }

    private readonly handleDisconnect = (userID: number, reason: DisconnectReason): void => {
        log('User(%d) was disconnected with reason: "%s"', userID, reason);

        if (this.sessions[userID].member.state.isPlayer) {
            this.sessions[userID].member.state.connected = false;
            this.sessions[userID].socket = null;
            this.broadcast("memberUpdate", userID, this.sessions[userID].member.state);

            if (this.gameStatus === GameStatus.InProgress) {
                this.sessions[userID].disconnectTimer = new PausableTimer(
                    catchErrors()(() => {
                        this.handleDisconnectTimeout(userID);
                    })
                );
                this.sessions[userID].disconnectTimer!.start(DisconnectTimeout);
            }
        } else {
            delete this.sessions[userID];
            this.broadcast("memberLeave", userID);
        }

        this.emit("connectedUsersChange");

        this.checkInactivity();
    };

    protected readonly connectedSessions = (): MemberSession[] => {
        return Object.values(this.sessions).filter((session) => session.member.state.connected);
    };

    protected startGame(): void {
        this.setUpGameBeforeStart();

        this.broadcast("gameStart");
        this.emit("gameStatusChange");

        log('Game started in room("%s")', this.id);
    }

    protected setUpGameBeforeStart(): void {
        return;
    }

    protected async checkGameEnd(): Promise<void> {
        let finished: boolean = this.isFinishCond();

        if (!finished) {
            return;
        }

        log('Game finished in room("%s")', this.id);
        this._gameState.status = GameStatus.Finished;
        let winnerId = this._gameState.winnerID;
        if (this.gameRules.timer) {
            this.broadcast("gameEnd", this._gameState.resolution!, winnerId, this.timer);
        } else {
            this.broadcast("gameEnd", this._gameState.resolution!, winnerId);
        }
        
        for (const session of Object.values(this.sessions)) {
            session.disconnectTimer?.stop();
        }

        if (winnerId) { 
            this.setWinnerId(winnerId);
        }

        this.emit("gameStatusChange");

        this.checkInactivity();

        await this.saveGame();
    };

    protected isFinishCond(): boolean {
        return false;
    }

    protected readonly broadcast = <Ev extends EventNames<ServerToClientEvents>>(
        ev: Ev,
        ...args: EventParams<ServerToClientEvents, Ev>
    ): void => {
        for (const session of Object.values(this.sessions)) {
            session.socket?.emit(ev, ...args);
        }
    };

    protected readonly broadcastExcept = <Ev extends EventNames<ServerToClientEvents>>(
        userID: number,
        ev: Ev,
        ...args: EventParams<ServerToClientEvents, Ev>
    ): void => {
        for (const session of Object.values(this.sessions)) {
            if (session.member.user.id !== userID) {
                session.socket?.emit(ev, ...args);
            }
        }
    };
}
