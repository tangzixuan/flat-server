import { FastifySchema, Response, ResponseError } from "../../../../types/Server";
import { ax } from "../../../utils/Axios";
import { AbstractController } from "../../../../abstract/controller";
import { Controller } from "../../../../decorator/Controller";
import { AI_SERVER_URL_CN, AI_SERVER_URL_EN } from "./const";
import { Status } from "../../../../constants/Project";

@Controller<RequestType, any>({
    method: "post",
    path: "agora/ai/start",
    auth: true,
})
export class AgoraAIStart extends AbstractController<RequestType, any> {
    public static readonly schema: FastifySchema<RequestType> = {
        body: {
            type: "object",
            required: ["request_id", "channel_name", "user_uid", "language", "scene", "role"],
            properties: {
                request_id: {
                    type: "string",
                },
                channel_name: {
                    type: "string",
                },
                user_uid: {
                    type: "string",
                },
                language: {
                    type: "string",
                },
                scene: {
                    type: "string",
                },
                role: {
                    type: "string",
                },
            },
        },
    };

    public async execute(): Promise<Response<any>> {
        const { request_id, channel_name, user_uid, language, role  } = this.body;
        const api = language === "cn" ? AI_SERVER_URL_CN : AI_SERVER_URL_EN;
        const res = await ax.post<any>(`${api}/start`, {
                request_id, 
                channel_name,
                user_uid,
                timber_type: role
            }, 
            {    
                headers: {
                    "Content-Type": "application/json"
                }
            }
        )
        
        return {
            status: Status.Success,
            data: res,
        }
    }

    public errorHandler(error: Error): ResponseError {
        return this.autoHandlerError(error);
    }
}

interface RequestType {
    body: {
        request_id: string;
        channel_name: string;
        user_uid: string;
        language: string;
        scene: string;
        role: string;
    };
}