import { Type } from "@sinclair/typebox";
import { FastifyRequestTypebox, Response } from "../../../types/Server";
import { UserBlacklistService } from "../../services/user/blacklist";
import { FError } from "../../../error/ControllerError";
import { ErrorCode } from "../../../ErrorCode";
import { successJSON } from "../internal/utils/response-json";

export const unbanUserSchema = {
    body: Type.Object(
        {
            phone: Type.Optional(Type.String({ minLength: 1, maxLength: 50 })),
            email: Type.Optional(Type.String({ format: "email", minLength: 1, maxLength: 100 })),
            userUUID: Type.Optional(Type.String({ format: "uuid-v4" })),
        },
        { additionalProperties: false },
    ),
};

export const unbanUser = async (
    req: FastifyRequestTypebox<typeof unbanUserSchema>,
): Promise<Response> => {
    const service = new UserBlacklistService(req.ids, req.DBTransaction);
    const { phone, email, userUUID } = req.body;

    const provided = [phone, email, userUUID].filter(Boolean);
    if (provided.length !== 1) {
        throw new FError(ErrorCode.ParamsCheckFailed);
    }

    if (phone) {
        await service.unbanByPhone(phone);
    } else if (email) {
        await service.unbanByEmail(email);
    } else if (userUUID) {
        await service.unbanByUserUUID(userUUID);
    }

    return successJSON({});
};
