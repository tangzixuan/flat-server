import { LoginProcess } from "../../Process";
import { Logger } from "../../../../../logger";
import { v4 } from "uuid";

export const createLoginProcess = (authUUID: string): LoginProcess => {
    const logger = new Logger<any>("test", {}, []);

    return new LoginProcess({
        logger,
        req: {
            body: {
                authUUID,
            },
            user: {},
            ids: {
                reqID: v4(),
                sesID: v4(),
            },
        },
        reply: {} as any,
    } as any);
};
