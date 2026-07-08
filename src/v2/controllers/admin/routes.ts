import { Server } from "../../../utils/registryRoutersV2";
import { banRooms, banRoomsSchema } from "./ban-rooms";
import { online, onlineSchema } from "./online";
import { roomMessages, roomMessagesSchema } from "./room-messages";
import { roomsInfo, roomsInfoSchema } from "./rooms-info";
import { banUser, banUserSchema } from "./ban-user";
import { unbanUser, unbanUserSchema } from "./unban-user";
import { banUserBatch, banUserBatchSchema } from "./ban-user-batch";
import { unbanUserBatch, unbanUserBatchSchema } from "./unban-user-batch";

export const adminRouters = (server: Server): void => {
    // /v2/rooms-info and /v2/online do not need admin
    server.post("rooms-info", roomsInfo, {
        schema: roomsInfoSchema,
        auth: false,
    });

    server.post("online", online, {
        schema: onlineSchema,
    });

    server.post("admin/ban-rooms", banRooms, {
        schema: banRoomsSchema,
        auth: false,
        admin: true,
    });

    server.post("admin/room-messages", roomMessages, {
        schema: roomMessagesSchema,
        auth: false,
        admin: true,
    });

    server.post("admin/ban-user", banUser, {
        schema: banUserSchema,
        auth: false,
        admin: true,
    });

    server.post("admin/unban-user", unbanUser, {
        schema: unbanUserSchema,
        auth: false,
        admin: true,
    });

    server.post("admin/ban-user/batch", banUserBatch, {
        schema: banUserBatchSchema,
        auth: false,
        admin: true,
    });

    server.post("admin/unban-user/batch", unbanUserBatch, {
        schema: unbanUserBatchSchema,
        auth: false,
        admin: true,
    });
};
