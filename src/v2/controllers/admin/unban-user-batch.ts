import { Type } from "@sinclair/typebox";
import { FastifyRequestTypebox, Response } from "../../../types/Server";
import { UserBlacklistService } from "../../services/user/blacklist";
import { FError } from "../../../error/ControllerError";
import { ErrorCode } from "../../../ErrorCode";
import { successJSON } from "../internal/utils/response-json";

export const unbanUserBatchSchema = {
    body: Type.Object(
        {
            phones: Type.Optional(
                Type.Array(Type.String({ minLength: 1, maxLength: 50 }), { maxItems: 500 }),
            ),
            emails: Type.Optional(
                Type.Array(
                    Type.String({ format: "email", minLength: 1, maxLength: 100 }),
                    { maxItems: 500 },
                ),
            ),
            userUUIDs: Type.Optional(
                Type.Array(Type.String({ format: "uuid-v4" }), { maxItems: 500 }),
            ),
        },
        { additionalProperties: false },
    ),
};

export const unbanUserBatch = async (
    req: FastifyRequestTypebox<typeof unbanUserBatchSchema>,
): Promise<Response> => {
    const service = new UserBlacklistService(req.ids, req.DBTransaction);
    const { phones, emails, userUUIDs } = req.body;

    const nonEmpty = [phones, emails, userUUIDs].filter(arr => arr && arr.length > 0);
    if (nonEmpty.length === 0 || nonEmpty.length > 1) {
        throw new FError(ErrorCode.ParamsCheckFailed);
    }

    if (phones?.length) {
        await service.unbanByPhones(phones);
    } else if (emails?.length) {
        await service.unbanByEmails(emails);
    } else if (userUUIDs?.length) {
        await service.unbanByUserUUIDs(userUUIDs);
    }

    return successJSON({});
};
