type FetchLike = typeof fetch;
type MatrixQaSendMessageContent = {
    body: string;
    format?: "org.matrix.custom.html";
    formatted_body?: string;
    "m.mentions"?: {
        user_ids?: string[];
    };
    "m.relates_to"?: {
        rel_type: "m.thread";
        event_id: string;
        is_falling_back: true;
        "m.in_reply_to": {
            event_id: string;
        };
    };
    msgtype: "m.text";
};
type MatrixQaSendReactionContent = {
    "m.relates_to": {
        event_id: string;
        key: string;
        rel_type: "m.annotation";
    };
};
type MatrixQaUiaaResponse = {
    completed?: string[];
    flows?: Array<{
        stages?: string[];
    }>;
    session?: string;
};
type MatrixQaRoomEvent = {
    content?: Record<string, unknown>;
    event_id?: string;
    origin_server_ts?: number;
    sender?: string;
    state_key?: string;
    type?: string;
};
export type MatrixQaObservedEvent = {
    roomId: string;
    eventId: string;
    sender?: string;
    stateKey?: string;
    type: string;
    originServerTs?: number;
    body?: string;
    formattedBody?: string;
    msgtype?: string;
    membership?: string;
    relatesTo?: {
        eventId?: string;
        inReplyToId?: string;
        isFallingBack?: boolean;
        relType?: string;
    };
    mentions?: {
        room?: boolean;
        userIds?: string[];
    };
    reaction?: {
        eventId?: string;
        key?: string;
    };
};
export type MatrixQaRegisteredAccount = {
    accessToken: string;
    deviceId?: string;
    localpart: string;
    password: string;
    userId: string;
};
export type MatrixQaProvisionResult = {
    driver: MatrixQaRegisteredAccount;
    observer: MatrixQaRegisteredAccount;
    roomId: string;
    sut: MatrixQaRegisteredAccount;
};
export type MatrixQaRoomEventWaitResult = {
    event: MatrixQaObservedEvent;
    matched: true;
    since?: string;
} | {
    matched: false;
    since?: string;
};
declare function buildMatrixThreadRelation(threadRootEventId: string, replyToEventId?: string): {
    "m.relates_to": {
        rel_type: "m.thread";
        event_id: string;
        is_falling_back: true;
        "m.in_reply_to": {
            event_id: string;
        };
    };
};
declare function buildMatrixReactionRelation(messageId: string, emoji: string): MatrixQaSendReactionContent;
declare function buildMatrixQaMessageContent(params: {
    body: string;
    mentionUserIds?: string[];
    replyToEventId?: string;
    threadRootEventId?: string;
}): MatrixQaSendMessageContent;
export declare function normalizeMatrixQaObservedEvent(roomId: string, event: MatrixQaRoomEvent): MatrixQaObservedEvent | null;
export declare function resolveNextRegistrationAuth(params: {
    registrationToken: string;
    response: MatrixQaUiaaResponse;
}): {
    session: string;
    type: "m.login.registration_token";
    token: string;
} | {
    session: string;
    type: "m.login.dummy";
    token?: undefined;
};
export declare function createMatrixQaClient(params: {
    accessToken?: string;
    baseUrl: string;
    fetchImpl?: FetchLike;
}): {
    createPrivateRoom(opts: {
        inviteUserIds: string[];
        name: string;
    }): Promise<string>;
    primeRoom(): Promise<string | undefined>;
    registerWithToken(opts: {
        deviceName: string;
        localpart: string;
        password: string;
        registrationToken: string;
    }): Promise<{
        accessToken: string;
        deviceId: string | undefined;
        localpart: string;
        password: string;
        userId: string;
    }>;
    sendTextMessage(opts: {
        body: string;
        mentionUserIds?: string[];
        replyToEventId?: string;
        roomId: string;
        threadRootEventId?: string;
    }): Promise<string>;
    sendReaction(opts: {
        emoji: string;
        messageId: string;
        roomId: string;
    }): Promise<string>;
    joinRoom(roomId: string): Promise<string>;
    waitForOptionalRoomEvent: (opts: {
        observedEvents: MatrixQaObservedEvent[];
        predicate: (event: MatrixQaObservedEvent) => boolean;
        roomId: string;
        since?: string;
        timeoutMs: number;
    }) => Promise<MatrixQaRoomEventWaitResult>;
    waitForRoomEvent(opts: {
        observedEvents: MatrixQaObservedEvent[];
        predicate: (event: MatrixQaObservedEvent) => boolean;
        roomId: string;
        since?: string;
        timeoutMs: number;
    }): Promise<{
        event: MatrixQaObservedEvent;
        since: string | undefined;
    }>;
};
export declare function provisionMatrixQaRoom(params: {
    baseUrl: string;
    fetchImpl?: FetchLike;
    roomName: string;
    driverLocalpart: string;
    observerLocalpart: string;
    registrationToken: string;
    sutLocalpart: string;
}): Promise<{
    driver: {
        accessToken: string;
        deviceId: string | undefined;
        localpart: string;
        password: string;
        userId: string;
    };
    observer: {
        accessToken: string;
        deviceId: string | undefined;
        localpart: string;
        password: string;
        userId: string;
    };
    roomId: string;
    sut: {
        accessToken: string;
        deviceId: string | undefined;
        localpart: string;
        password: string;
        userId: string;
    };
}>;
export declare const __testing: {
    buildMatrixQaMessageContent: typeof buildMatrixQaMessageContent;
    buildMatrixReactionRelation: typeof buildMatrixReactionRelation;
    buildMatrixThreadRelation: typeof buildMatrixThreadRelation;
    normalizeMatrixQaObservedEvent: typeof normalizeMatrixQaObservedEvent;
    resolveNextRegistrationAuth: typeof resolveNextRegistrationAuth;
};
export {};
