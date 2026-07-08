import { FastifySchema, Response, ResponseError } from "../../../types/Server";
import RedisService from "../../../thirdPartyService/RedisService";
import { RedisKey } from "../../../utils/Redis";
import { Status } from "../../../constants/Project";
import { ErrorCode } from "../../../ErrorCode";
import { AbstractController } from "../../../abstract/controller";
import { Controller } from "../../../decorator/Controller";
import { AbstractLogin } from "../../../abstract/login";
import { dataSource } from "../../../thirdPartyService/TypeORMService";
import { UserBlacklistService } from "../../../v2/services/user/blacklist";

@Controller<RequestType, ResponseType>({
    method: "post",
    path: "login/process",
    auth: false,
})
export class LoginProcess extends AbstractController<RequestType, ResponseType> {
    public static readonly schema: FastifySchema<RequestType> = {
        body: {
            type: "object",
            required: ["authUUID"],
            properties: {
                authUUID: {
                    type: "string",
                    format: "uuid-v4",
                },
            },
        },
    };

    public async execute(): Promise<Response<ResponseType>> {
        const { authUUID } = this.body;

        await AbstractLogin.assertHasAuthUUID(authUUID, this.logger);

        const failedReason = await RedisService.get(RedisKey.authFailed(authUUID));

        if (failedReason !== null) {
            const code =
                failedReason === "application_suspended"
                    ? ErrorCode.LoginGithubSuspended
                    : failedReason === "redirect_uri_mismatch"
                    ? ErrorCode.LoginGithubURLMismatch
                    : failedReason === "access_denied"
                    ? ErrorCode.LoginGithubAccessDenied
                    : failedReason === "user_blacklisted"
                    ? ErrorCode.UserBlacklisted
                    : ErrorCode.CurrentProcessFailed;

            return {
                status: Status.Failed,
                code,
            };
        }

        const userInfoStr = await RedisService.get(RedisKey.authUserInfo(authUUID));

        if (userInfoStr === null) {
            return {
                status: Status.Success,
                data: {
                    name: "",
                    avatar: "",
                    userUUID: "",
                    token: "",
                    hasPhone: false,
                    hasPassword: false,
                },
            };
        }

        const userInfo = JSON.parse(userInfoStr);

        await new UserBlacklistService(this.req.ids, dataSource.manager).assertNotBanned({
            userUUID: userInfo.userUUID,
        });

        return {
            status: Status.Success,
            data: userInfo,
        };
    }

    public errorHandler(error: Error): ResponseError {
        return this.autoHandlerError(error);
    }
}

interface RequestType {
    body: {
        authUUID: string;
    };
}

type ResponseType = {
    name: string;
    avatar: string;
    userUUID: string;
    token: string;
    hasPhone: boolean;
    hasPassword: boolean;
};
