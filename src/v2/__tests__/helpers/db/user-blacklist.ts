import { v4 } from "uuid";
import { EntityManager } from "typeorm";
import { userBlacklistDAO } from "../../../dao";
import { randomPhoneNumber } from "./user-phone";

export class CreateUserBlacklist {
    public constructor(private readonly t: EntityManager) {}

    public async full(info: {
        userUUID: string | null;
        phoneNumber: string | null;
        email: string | null;
        reason: string | null;
        operator: string | null;
    }) {
        await userBlacklistDAO.insert(this.t, {
            user_uuid: info.userUUID,
            phone_number: info.phoneNumber,
            email: info.email,
            reason: info.reason,
            operator: info.operator,
        });
        return info;
    }

    public async byPhone(phone?: string) {
        const fullInfo = {
            userUUID: null,
            phoneNumber: phone || randomPhoneNumber(),
            email: null,
            reason: null,
            operator: null,
        };
        await this.full(fullInfo);
        return fullInfo;
    }

    public async byEmail(email?: string) {
        const fullInfo = {
            userUUID: null,
            phoneNumber: null,
            email: email || `${v4()}@example.com`,
            reason: null,
            operator: null,
        };
        await this.full(fullInfo);
        return fullInfo;
    }

    public async byUserUUID(userUUID?: string) {
        const fullInfo = {
            userUUID: userUUID || v4(),
            phoneNumber: null,
            email: null,
            reason: null,
            operator: null,
        };
        await this.full(fullInfo);
        return fullInfo;
    }
}
