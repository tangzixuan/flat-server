import { JoinRoom } from "../..";
import { Logger } from "../../../../../../logger";
import { v4 } from "uuid";

export const createJoinRoom = (roomUUID: string, userUUID: string): JoinRoom => {
    const logger = new Logger<any>("test", {}, []);
    return new JoinRoom({
        logger,
        req: {
            body: {
                uuid: roomUUID,
            },
            user: {
                userUUID,
            },
            ids: {
                reqID: v4(),
                sesID: v4(),
            },
        },
        reply: {},
    } as any);
};
