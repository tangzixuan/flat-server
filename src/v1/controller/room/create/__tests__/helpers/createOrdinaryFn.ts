import { CreateOrdinary, RequestType } from "../../Ordinary";
import { ControllerClassParams } from "../../../../../../abstract/controller";
import { Logger } from "../../../../../../logger";
import { v4 } from "uuid";

export const createOrdinaryFn = (userUUID: string, body: RequestType["body"]): CreateOrdinary => {
    const logger = new Logger<any>("test", {}, []);

    return new CreateOrdinary({
        logger,
        req: {
            body,
            user: {
                userUUID,
            },
            ids: {
                reqID: v4(),
                sesID: v4(),
            },
        },
        reply: {},
    } as ControllerClassParams);
};
