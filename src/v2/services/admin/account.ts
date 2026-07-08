import { createHash, timingSafeEqual } from "crypto";
import { EntityManager } from "typeorm";
import { adminAccountDAO } from "../../dao";

export type AdminLoginResult = {
    username: string;
};

export const adminPasswordHash = (password: string, salt: string): string => {
    return createHash("sha256").update(`${salt}:${password}`).digest("hex");
};

export class AdminAccountService {
    public constructor(private readonly t: EntityManager) {}

    public async login(username: string, password: string): Promise<AdminLoginResult | null> {
        const account = await adminAccountDAO.findOne(
            this.t,
            ["username", "password_hash", "password_salt"],
            { username },
        );

        if (!account) {
            return null;
        }

        const actual = adminPasswordHash(password, account.password_salt);
        if (!AdminAccountService.safeEqual(actual, account.password_hash)) {
            return null;
        }

        await adminAccountDAO.update(
            this.t,
            { last_login_at: new Date() },
            { username },
        );

        return {
            username: account.username,
        };
    }

    private static safeEqual(left: string, right: string): boolean {
        const leftBuffer = Buffer.from(left);
        const rightBuffer = Buffer.from(right);
        if (leftBuffer.length !== rightBuffer.length) {
            return false;
        }
        return timingSafeEqual(leftBuffer, rightBuffer);
    }
}
