import { Login } from "../../Login";
import { Logger } from "../../../../../logger";
import { v4 } from "uuid";
import { LoginPlatform } from "../../../../../constants/Project";

export const createLogin = (userUUID: string): Login => {
    const logger = new Logger<any>("test", {}, []);

    return new Login({
        logger,
        req: {
            body: {},
            user: {
                userUUID,
                loginSource: LoginPlatform.Github,
            },
            ids: {
                reqID: v4(),
                sesID: v4(),
            },
        },
        reply: {} as any,
    } as any);
};
