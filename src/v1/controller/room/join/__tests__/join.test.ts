import test from "ava";
import { dataSource } from "../../../../../thirdPartyService/TypeORMService";
import { v4 } from "uuid";
import { createRoom, createRoomUser } from "../../info/__tests__/helpers/createUsersRequest";
import { createCancel } from "./helpers/createCancelOrdinary";
import { createJoinRoom } from "./helpers/createJoinRoom";
import { RoomStatus } from "../../../../../model/room/Constants";
import { Status } from "../../../../../constants/Project";
import { ErrorCode } from "../../../../../ErrorCode";
import { RoomUserDAO, UserDAO } from "../../../../../dao";
import { UserBlacklistService } from "../../../../../v2/services/user/blacklist";

const namespace = "[api][api-v1][api-v1-room][api-v1-room-join]";

test.before(`${namespace} - initialize dataSource`, async () => {
    await dataSource.initialize();
});

test.after(`${namespace} - destroy dataSource`, async () => {
    await dataSource.destroy();
});

test(`${namespace} - join after user cancel`, async ava => {
    const [roomUUID] = [v4()];
    const [ownerUUID, anotherUserUUID] = await createRoomUser(roomUUID, 2);
    await createRoom(ownerUUID, roomUUID, RoomStatus.Started);

    const joinRoom = createJoinRoom(roomUUID, anotherUserUUID);
    const result = await joinRoom.execute();
    const f: number = (result as any).data.rtcUID;

    await createCancel(roomUUID, anotherUserUUID).execute();

    const joinRoom1 = createJoinRoom(roomUUID, anotherUserUUID);
    const join1Result = await joinRoom1.execute();
    const f1: number = (join1Result as any).data.rtcUID;

    ava.is(f > 0 && f1 > 0, true);
    ava.is(f == f1, true);
});

test(`${namespace} - reject join when room not begin`, async ava => {
    const [roomUUID] = [v4()];
    const [ownerUUID] = await createRoomUser(roomUUID, 2);
    const joinUserId = v4();
    await UserDAO().insert({
        user_uuid: joinUserId,
        user_name: "test_name",
        avatar_url: "xxx",
        user_password: "",
    });

    await createRoom(ownerUUID, roomUUID, RoomStatus.Idle, new Date(new Date().getTime() + 24 * 3600 * 1000));

    const joinRoom = createJoinRoom(roomUUID, joinUserId);
    const result = await joinRoom.execute();
    ava.is(result.status, Status.Failed);
    ava.is((result as any).code, ErrorCode.RoomNotBegin);
    const data = await RoomUserDAO().findOne(["id", "rtc_uid", "room_uuid", "user_uuid", "updated_at"], {
        user_uuid: joinUserId,
        room_uuid: roomUUID,
    });
    ava.not(data, undefined);
});

test(`${namespace} - blacklisted user join existing room rejected`, async ava => {
    ava.plan(1);

    const roomUUID = v4();
    const [ownerUUID] = await createRoomUser(roomUUID, 1);
    const joinUserId = v4();
    await UserDAO().insert({
        user_uuid: joinUserId,
        user_name: "test_name",
        avatar_url: "xxx",
        user_password: "",
    });
    await createRoom(ownerUUID, roomUUID, RoomStatus.Started);

    await new UserBlacklistService(
        { reqID: v4(), sesID: v4() },
        dataSource.manager,
    ).banByUserUUID(joinUserId);

    const joinRoom = createJoinRoom(roomUUID, joinUserId);
    try {
        await joinRoom.execute();
    } catch (error) {
        ava.is(joinRoom.errorHandler(error as Error).code, ErrorCode.UserBlacklisted);
    }
});

test(`${namespace} - blacklisted user join nonexistent room returns RoomNotFound`, async ava => {
    ava.plan(1);

    const joinUserId = v4();
    await UserDAO().insert({
        user_uuid: joinUserId,
        user_name: "test_name",
        avatar_url: "xxx",
        user_password: "",
    });

    await new UserBlacklistService(
        { reqID: v4(), sesID: v4() },
        dataSource.manager,
    ).banByUserUUID(joinUserId);

    const joinRoom = createJoinRoom(v4(), joinUserId);
    try {
        await joinRoom.execute();
    } catch (error) {
        ava.is(joinRoom.errorHandler(error as Error).code, ErrorCode.RoomNotFound);
    }
});

test(`${namespace} - blacklisted user join with wrong invite code returns RoomNotFound`, async ava => {
    ava.plan(1);

    const joinUserId = v4();
    await UserDAO().insert({
        user_uuid: joinUserId,
        user_name: "test_name",
        avatar_url: "xxx",
        user_password: "",
    });

    await new UserBlacklistService(
        { reqID: v4(), sesID: v4() },
        dataSource.manager,
    ).banByUserUUID(joinUserId);

    // 10-digit invite code that does not map to any room
    const wrongInviteCode = "1234567890";
    const joinRoom = createJoinRoom(wrongInviteCode, joinUserId);
    try {
        await joinRoom.execute();
    } catch (error) {
        ava.is(joinRoom.errorHandler(error as Error).code, ErrorCode.RoomNotFound);
    }
});
