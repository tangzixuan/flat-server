import { Type } from "@sinclair/typebox";
import { FastifyRequestTypebox, Response } from "../../../types/Server";
import { UserBlacklistService } from "../../services/user/blacklist";
import { FError } from "../../../error/ControllerError";
import { ErrorCode } from "../../../ErrorCode";
import { successJSON } from "../internal/utils/response-json";

export const banUserSchema = {
    body: Type.Object(
        {
            phone: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
            email: Type.Optional(Type.String({ format: "email", minLength: 1, maxLength: 100 })),
            userUUID: Type.Optional(Type.String({ format: "uuid-v4" })),
            reason: Type.Optional(Type.String({ maxLength: 255 })),
        },
        { additionalProperties: false },
    ),
};

export const banUser = async (
    req: FastifyRequestTypebox<typeof banUserSchema>,
): Promise<Response> => {
    const service = new UserBlacklistService(req.ids, req.DBTransaction);
    const { phone, email, userUUID, reason } = req.body;
    const operator = req.userUUID;

    const provided = [phone, email, userUUID].filter(Boolean);
    if (provided.length !== 1) {
        throw new FError(ErrorCode.ParamsCheckFailed);
    }

    if (phone) {
        await service.banByPhone(phone, reason, operator);
    } else if (email) {
        await service.banByEmail(email, reason, operator);
    } else if (userUUID) {
        const { matchedCount, skippedCount } = await service.banByUserUUID(
            userUUID,
            reason,
            operator,
        );
        return successJSON({ matchedCount, skippedCount });
    }

    return successJSON({});
};
