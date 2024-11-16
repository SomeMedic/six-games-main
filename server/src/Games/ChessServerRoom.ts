import {Chess} from "chess.js";
import config from "config";
import debug from "debug";
import {DateTime} from "luxon";
import ShortUniqueId from "short-unique-id";
import {DisconnectReason} from "socket.io";
import {EventNames, EventParams} from "socket.io/dist/typed-events.js";

import {PlayedGame} from "../GameServer/Database.js";
import {ServerRoomTest} from "../GameServer/ServerRoomTest.js";
import {ServerRoom} from "../GameServer/ServerRoom.js";
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
} from "../GameServer/DataModel.js";
import {AlreadyConnectedError, IllegalMoveError} from "../GameServer/Errors.js";
import {Socket} from "../GameServer/GameServer.js";
import {PausableTimer} from "../GameServer/PausableTimer.js";
import {catchErrors} from "../GameServer/SocketErrorHandler.js";
import {TypedEventEmitter} from "../GameServer/TypedEventEmitter.js";

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


export class ChessServerRoom extends ServerRoom {
    public readonly id: string;

    public readonly hostID: number;

    public readonly createdDateTime: DateTime;

    public readonly gameRules: GameRules;

    protected readonly _gameState: Omit<GameState, "turn" | "pgn" | "timer">;

    protected readonly sessions: {[key: number]: MemberSession};

    private readonly chess: Chess;

    private whitePlayerID: number | undefined;
    private blackPlayerID: number | undefined;

    private whiteTimer: PausableTimer | undefined;
    private blackTimer: PausableTimer | undefined;

    public static randomColor(): Color {
        return Math.floor(Math.random() * 2) === 1 ? Color.White : Color.Black;
    }

    public static swapColor(color: Color): Color {
        return color === Color.White ? Color.Black : Color.White;
    }

    public constructor(host: User, gameRules: GameRules, id?: string) {
        super(host, gameRules, id);

        if (id) {
            this.id = id;
        } else {
            this.id = UID.rnd();
        }

        log('Created new chess room("%s")', this.id);

        this.createdDateTime = DateTime.now();

        this.sessions = {};
        this.sessions[host.id] = {
            member: {
                user: host,
                state: {
                    connected: false,
                    isPlayer: true,
                    color: gameRules.hostPreferredColor || ChessServerRoom.randomColor(),
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
        this.chess = new Chess();

        if (this.sessions[host.id].member.state.color === Color.White) {
            this.whitePlayerID = host.id;
        } else {
            this.blackPlayerID = host.id;
        }
    }

    public get host(): User {
        return this.sessions[this.hostID].member.user;
    }

    public get connectedUsers(): User[] {
        return this.connectedSessions().map((session) => session.member.user);
    }

    public readonly gameState = (): GameState => {
        return {
            ...this._gameState,
            turn: this.chess.turn() as Color,
            pgn: this.chess.pgn(),
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

    public get timer(): TimerState | undefined {
        if (!this.whiteTimer || !this.blackTimer) {
            return;
        }
        return {
            whiteTimeLeft: this.whiteTimer.timeLeft,
            blackTimeLeft: this.blackTimer.timeLeft,
        };
    }

    public acceptConnection(socket: Socket, user: User): void {
        super.acceptConnection(socket, user);

        if (
            this._gameState.status === GameStatus.NotStarted &&
            this.numberOfConnectedMembers() >= 2 &&
            this.sessions[this.hostID].member.state.connected
        ) {
            this.startGame();
        } else if (this._gameState.status === GameStatus.InProgress) {
            if (user.id === this.whitePlayerID || user.id === this.blackPlayerID) {
                this.subscribeToEvents(this.sessions[user.id]);
            }
        }

        this.emit("connectedUsersChange");
    };

    protected async saveGame(): Promise<void> {
        await super.saveGame();

        const gameState = this.gameState();

        let winner: Color | null = null;
        if (gameState.winnerID === this.whitePlayerID) {
            winner = Color.White;
        } else if (gameState.winnerID === this.blackPlayerID) {
            winner = Color.Black;
        }

        await PlayedGame.create(
            {
                id: this.id,
                timerEnabled: this.gameRules.timer,
                timerInit: this.gameRules.initialTime || 0,
                timerIncrement: this.gameRules.timerIncrement || 0,
                pgn: gameState.pgn,
                resolution: gameState.resolution!,
                winner: winner,
                whitePlayerID: this.whitePlayerID!,
                blackPlayerID: this.blackPlayerID!,
            },
            {}
        );
    }

    protected async handleDisconnectTimeout(userID: number): Promise<void> {
        this._gameState.resolution = GameResolution.PlayerQuit;
        this._gameState.winnerID = userID === this.whitePlayerID ? this.blackPlayerID : this.whitePlayerID;
    
        await super.handleDisconnectTimeout(userID);

        this.whiteTimer?.pause();
        this.blackTimer?.pause();
    }

    protected startGame(): void {
        super.startGame();     
    }

    protected setUpGameBeforeStart(): void {
        this.selectOpponent();

        this.subscribeToEvents(this.sessions[this.whitePlayerID!]);
        this.subscribeToEvents(this.sessions[this.blackPlayerID!]);

        this._gameState.status = GameStatus.InProgress;

        if (this.gameRules.timer) {
            this.whiteTimer = new PausableTimer(
                catchErrors()(() => this.handleTimerOut(Color.White)),
                this.gameRules.initialTime! * 1000
            );
            this.blackTimer = new PausableTimer(
                catchErrors()(() => this.handleTimerOut(Color.Black)),
                this.gameRules.initialTime! * 1000
            );

            this.whiteTimer.start();
        }
    }

    protected readonly subscribeToEvents = (session: MemberSession): void => {
        const color = session.member.state.color!;
        session.socket!.on(
            "makeMove",
            catchErrors(session.socket!)((move: Move) => {
                this.handleMove(move, color);
            })
        );
        session.socket!.on(
            "giveUp",
            catchErrors(session.socket!)(() => {
                this.handleGiveUp(color);
            })
        );
    };

    private readonly selectOpponent = (): void => {
        const hostColor = this.sessions[this.hostID].member.state.color!;

        const connectedSessions = this.connectedSessions();
        const nonPlayerSessions = connectedSessions.filter((session) => !session.member.state.isPlayer);
        //Sort by date, the first one is in the end
        nonPlayerSessions.sort((a, b) => b.joined.toMillis() - a.joined.toMillis());

        const selectedSession = nonPlayerSessions.pop()!;
        selectedSession.member.state.isPlayer = true;
        selectedSession.member.state.color = ChessServerRoom.swapColor(hostColor);

        if (selectedSession.member.state.color === Color.White) {
            this.whitePlayerID = selectedSession.member.user.id;
        } else {
            this.blackPlayerID = selectedSession.member.user.id;
        }

        log(
            "Promoting user(%d) to player, his color is %s",
            selectedSession.member.user.id,
            selectedSession.member.state.color
        );

        this.broadcast("memberUpdate", selectedSession.member.user.id, selectedSession.member.state);
    };

    private readonly handleMove = (move: Move, color: Color): void => {
        if (this._gameState.status !== GameStatus.InProgress) {
            throw new IllegalMoveError("Game is not in progress");
        }

        if (this.chess.turn() !== color) {
            throw new IllegalMoveError("This was not your turn");
        }

        this.chess.move(move);

        if (this.gameRules.timer) {
            if (this.chess.turn() === Color.White) {
                this.whiteTimer!.start();
                this.blackTimer!.pause();

                this.blackTimer!.addTime(this.gameRules.timerIncrement! * 1000);
            } else {
                this.blackTimer!.start();
                this.whiteTimer!.pause();

                this.whiteTimer!.addTime(this.gameRules.timerIncrement! * 1000);
            }
            this.broadcast("move", move, this.timer);
        } else {
            this.broadcast("move", move);
        }

        log('Move from %s to %s was made in room("%s")', move.from, move.to, this.id);

        if (this.isFinishCond()) {
            this.checkGameEnd();
        }
    };

    private readonly handleGiveUp = async (color: Color): Promise<void> => {
        if (this.gameStatus !== GameStatus.InProgress) {
            return;
        }
        log('Game finished in room("%s"), because user gave up', this.id);

        this._gameState.resolution = GameResolution.GiveUp;
        this._gameState.winnerID = color === Color.White ? this.blackPlayerID : this.whitePlayerID;

        this._gameState.status = GameStatus.Finished;
        this.whiteTimer?.pause();
        this.blackTimer?.pause();
        for (const session of Object.values(this.sessions)) {
            session.disconnectTimer?.stop();
        }
        if (this.gameRules.timer) {
            this.broadcast("gameEnd", this._gameState.resolution!, this._gameState.winnerID, this.timer);
        } else {
            this.broadcast("gameEnd", this._gameState.resolution!, this._gameState.winnerID);
        }

        this.emit("gameStatusChange");

        this.checkInactivity();

        await this.saveGame();
    };

    protected async checkGameEnd(): Promise<void> {
        this.whiteTimer?.pause();
        this.blackTimer?.pause();

        super.checkGameEnd();
    };

    protected isFinishCond(): boolean {
        let finished: boolean = false;

        if (this.chess.isCheckmate()) {
            this._gameState.resolution = GameResolution.Checkmate;
            this._gameState.winnerID = this.chess.turn() === Color.White ? this.blackPlayerID : this.whitePlayerID;
            finished = true;
        } else if (this.chess.isStalemate()) {
            this._gameState.resolution = GameResolution.Stalemate;
            finished = true;
        } else if (this.chess.isDraw()) {
            this._gameState.resolution = GameResolution.Draw;
            finished = true;
        }

        return finished;
    }

    private readonly handleTimerOut = async (side: Color): Promise<void> => {
        log('Game finished in room("%s"), because the timer ran out', this.id);

        this.whiteTimer!.stop();
        this.blackTimer!.stop();
        for (const session of Object.values(this.sessions)) {
            session.disconnectTimer?.stop();
        }

        this._gameState.resolution = GameResolution.OutOfTime;
        this._gameState.winnerID = side === Color.White ? this.blackPlayerID : this.whitePlayerID;

        this._gameState.status = GameStatus.Finished;
        this.broadcast("gameEnd", this._gameState.resolution, this._gameState.winnerID, this.timer);
        this.emit("gameStatusChange");
        this.checkInactivity();

        await this.saveGame();
    };
}
