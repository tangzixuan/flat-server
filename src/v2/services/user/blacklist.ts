import { EntityManager, FindOptionsWhere, In, IsNull } from "typeorm";
import { FError } from "../../../error/ControllerError";
import { ErrorCode } from "../../../ErrorCode";
import { createLoggerService } from "../../../logger";
import { UserBlacklistModel } from "../../../model/user/Blacklist";
import { userBlacklistDAO, userDAO, userEmailDAO, userPhoneDAO } from "../../dao";
import RedisService from "../../../thirdPartyService/RedisService";
import { RedisKey } from "../../../utils/Redis";

const BLACKLIST_CACHE_TTL_SECONDS = 60 * 60 * 24 * 29;

export interface BanByUserUUIDResult {
    matchedCount: number;
    skippedCount: number;
}

export const normalizeBlacklistPhone = (phone: string): string => {
    const digits = phone.match(/\d+/g)?.join("") ?? "";
    if (digits.length === 0) {
        throw new FError(ErrorCode.ParamsCheckFailed);
    }
    return digits;
};
export const normalizeBlacklistEmail = (email: string): string => email.toLowerCase();

const phoneVariants = (safePhone: string): string[] => {
    const variants = [safePhone, `+${safePhone}`];
    return Array.from(new Set(variants));
};

export class UserBlacklistService {
    private readonly logger = createLoggerService<"userBlacklist">({
        serviceName: "userBlacklist",
        ids: this.ids,
    });

    constructor(
        private readonly ids: IDS,
        private readonly DBTransaction: EntityManager,
    ) {}

    public async banByPhone(phone: string, reason?: string, operator?: string): Promise<void> {
        await this.banByPhones([phone], reason, operator);
    }

    public async banByEmail(email: string, reason?: string, operator?: string): Promise<void> {
        await this.banByEmails([email], reason, operator);
    }

    public async banByUserUUID(
        userUUID: string,
        reason?: string,
        operator?: string,
    ): Promise<BanByUserUUIDResult> {
        return this.banByUserUUIDs([userUUID], reason, operator);
    }

    public async banByPhones(
        phones: string[],
        reason?: string,
        operator?: string,
    ): Promise<void> {
        const uniquePhones = Array.from(
            new Set(phones.filter(Boolean).map(normalizeBlacklistPhone)),
        );
        if (uniquePhones.length === 0) return;

        const phoneUserPairs = await userPhoneDAO.find(
            this.DBTransaction,
            ["phone_number", "user_uuid"],
            { phone_number: In(uniquePhones.flatMap(phoneVariants)) },
        );
        const phoneToUserUUID = new Map(
            phoneUserPairs.map(p => [normalizeBlacklistPhone(p.phone_number), p.user_uuid] as const),
        );

        await userBlacklistDAO.deleteHard(this.DBTransaction, {
            phone_number: In(uniquePhones),
        });

        const records = uniquePhones.map(phone => ({
            phone_number: phone,
            user_uuid: phoneToUserUUID.get(phone) ?? null,
            reason: reason ?? null,
            operator: operator ?? null,
        }));
        await userBlacklistDAO.insert(this.DBTransaction, records);

        const matchedUserUUIDs = Array.from(new Set(phoneToUserUUID.values()));
        if (matchedUserUUIDs.length > 0) {
            await userDAO.update(
                this.DBTransaction,
                { is_blacklist: true },
                { user_uuid: In(matchedUserUUIDs) },
            );
            await this.setBanCache(matchedUserUUIDs);
        }
    }

    public async banByEmails(
        emails: string[],
        reason?: string,
        operator?: string,
    ): Promise<void> {
        const uniqueEmails = Array.from(
            new Set(emails.filter(Boolean).map(normalizeBlacklistEmail)),
        );
        if (uniqueEmails.length === 0) return;

        const emailUserPairs = await userEmailDAO.find(
            this.DBTransaction,
            ["user_email", "user_uuid"],
            { user_email: In(uniqueEmails) },
        );
        const emailToUserUUID = new Map(
            emailUserPairs.map(e => [normalizeBlacklistEmail(e.user_email), e.user_uuid] as const),
        );

        await userBlacklistDAO.deleteHard(this.DBTransaction, {
            email: In(uniqueEmails),
        });

        const records = uniqueEmails.map(email => ({
            email,
            user_uuid: emailToUserUUID.get(email) ?? null,
            reason: reason ?? null,
            operator: operator ?? null,
        }));
        await userBlacklistDAO.insert(this.DBTransaction, records);

        const matchedUserUUIDs = Array.from(new Set(emailToUserUUID.values()));
        if (matchedUserUUIDs.length > 0) {
            await userDAO.update(
                this.DBTransaction,
                { is_blacklist: true },
                { user_uuid: In(matchedUserUUIDs) },
            );
            await this.setBanCache(matchedUserUUIDs);
        }
    }

    public async banByUserUUIDs(
        userUUIDs: string[],
        reason?: string,
        operator?: string,
    ): Promise<BanByUserUUIDResult> {
        const uniqueUUIDs = Array.from(new Set(userUUIDs.filter(Boolean)));
        if (uniqueUUIDs.length === 0) {
            return { matchedCount: 0, skippedCount: 0 };
        }

        const existingUsers = await userDAO.find(
            this.DBTransaction,
            ["user_uuid"],
            { user_uuid: In(uniqueUUIDs) },
        );
        const existingSet = new Set(existingUsers.map(u => u.user_uuid));

        await userBlacklistDAO.deleteHard(this.DBTransaction, {
            user_uuid: In(uniqueUUIDs),
            phone_number: IsNull(),
            email: IsNull(),
        });

        const records = uniqueUUIDs
            .filter(uuid => existingSet.has(uuid))
            .map(userUUID => ({
                user_uuid: userUUID,
                reason: reason ?? null,
                operator: operator ?? null,
            }));
        if (records.length > 0) {
            await userBlacklistDAO.insert(this.DBTransaction, records);
        }

        if (existingSet.size > 0) {
            await userDAO.update(
                this.DBTransaction,
                { is_blacklist: true },
                { user_uuid: In(Array.from(existingSet)) },
            );
            await this.setBanCache(Array.from(existingSet));
        }

        return {
            matchedCount: existingSet.size,
            skippedCount: uniqueUUIDs.length - existingSet.size,
        };
    }

    public async unbanByPhone(phone: string): Promise<void> {
        await this.unbanByPhones([phone]);
    }

    public async unbanByEmail(email: string): Promise<void> {
        await this.unbanByEmails([email]);
    }

    public async unbanByUserUUID(userUUID: string): Promise<void> {
        await this.unbanByUserUUIDs([userUUID]);
    }

    public async unbanByPhones(phones: string[]): Promise<void> {
        const uniquePhones = Array.from(
            new Set(phones.filter(Boolean).map(normalizeBlacklistPhone)),
        );
        if (uniquePhones.length === 0) return;

        const blacklistRecords = await userBlacklistDAO.find(
            this.DBTransaction,
            ["user_uuid"],
            { phone_number: In(uniquePhones) },
        );
        const affectedUserUUIDs = this.collectUserUUIDs(blacklistRecords);

        await userBlacklistDAO.delete(this.DBTransaction, {
            phone_number: In(uniquePhones),
        });

        const toReset = await this.resetUserBlacklistFlag(affectedUserUUIDs);
        await this.clearBanCache(toReset);
    }

    public async unbanByEmails(emails: string[]): Promise<void> {
        const uniqueEmails = Array.from(
            new Set(emails.filter(Boolean).map(normalizeBlacklistEmail)),
        );
        if (uniqueEmails.length === 0) return;

        const blacklistRecords = await userBlacklistDAO.find(
            this.DBTransaction,
            ["user_uuid"],
            { email: In(uniqueEmails) },
        );
        const affectedUserUUIDs = this.collectUserUUIDs(blacklistRecords);

        await userBlacklistDAO.delete(this.DBTransaction, {
            email: In(uniqueEmails),
        });

        const toReset = await this.resetUserBlacklistFlag(affectedUserUUIDs);
        await this.clearBanCache(toReset);
    }

    public async unbanByUserUUIDs(userUUIDs: string[]): Promise<void> {
        const uniqueUUIDs = Array.from(new Set(userUUIDs.filter(Boolean)));
        if (uniqueUUIDs.length === 0) return;

        await userBlacklistDAO.delete(this.DBTransaction, {
            user_uuid: In(uniqueUUIDs),
        });

        const toReset = await this.resetUserBlacklistFlag(uniqueUUIDs);
        await this.clearBanCache(toReset);
    }

    public async assertNotBanned(
        identifier: { phone?: string; email?: string; userUUID?: string },
    ): Promise<void> {
        const or = this.buildOrConditions(identifier);
        if (or.length === 0) return;

        const found = await this.DBTransaction.getRepository(UserBlacklistModel).findOne({
            where: or,
            select: ["id"],
        });

        if (found) {
            this.logger.warn("user blacklisted", { userBlacklist: identifier });
            throw new FError(ErrorCode.UserBlacklisted);
        }
    }

    public async isBanned(
        identifier: { phone?: string; email?: string; userUUID?: string },
    ): Promise<boolean> {
        const or = this.buildOrConditions(identifier);
        if (or.length === 0) return false;

        const found = await this.DBTransaction.getRepository(UserBlacklistModel).findOne({
            where: or,
            select: ["id"],
        });
        return Boolean(found);
    }

    private buildOrConditions(
        identifier: { phone?: string; email?: string; userUUID?: string },
    ): FindOptionsWhere<UserBlacklistModel>[] {
        const or: FindOptionsWhere<UserBlacklistModel>[] = [];
        if (identifier.phone) {
            or.push({ phone_number: normalizeBlacklistPhone(identifier.phone), is_delete: false });
        }
        if (identifier.email) {
            or.push({ email: normalizeBlacklistEmail(identifier.email), is_delete: false });
        }
        if (identifier.userUUID) {
            or.push({ user_uuid: identifier.userUUID, is_delete: false });
        }
        return or;
    }

    private collectUserUUIDs(
        records: Array<{ user_uuid: string | null }>,
    ): string[] {
        return Array.from(
            new Set(
                records
                    .map(r => r.user_uuid)
                    .filter((uuid): uuid is string => uuid !== null),
            ),
        );
    }

    private async resetUserBlacklistFlag(userUUIDs: string[]): Promise<string[]> {
        if (userUUIDs.length === 0) return [];

        const stillBanned = await userBlacklistDAO.find(
            this.DBTransaction,
            ["user_uuid"],
            { user_uuid: In(userUUIDs) },
        );
        const stillBannedSet = new Set(this.collectUserUUIDs(stillBanned));
        const toReset = userUUIDs.filter(uuid => !stillBannedSet.has(uuid));

        if (toReset.length > 0) {
            await userDAO.update(
                this.DBTransaction,
                { is_blacklist: false },
                { user_uuid: In(toReset) },
            );
        }

        return toReset;
    }

    private async setBanCache(userUUIDs: string[]): Promise<void> {
        if (userUUIDs.length === 0) return;
        await Promise.all(
            userUUIDs.map(uuid =>
                RedisService.set(RedisKey.userBlacklist(uuid), "1", BLACKLIST_CACHE_TTL_SECONDS),
            ),
        );
    }

    private async clearBanCache(userUUIDs: string[]): Promise<void> {
        if (userUUIDs.length === 0) return;
        await RedisService.del(userUUIDs.map(uuid => RedisKey.userBlacklist(uuid)));
    }
}
