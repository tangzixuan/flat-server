import { Column, Entity, Index } from "typeorm";
import { Content } from "../Content";

@Entity({
    name: "admin_accounts",
})
export class AdminAccountModel extends Content {
    @Index("admin_accounts_username_uindex", {
        unique: true,
    })
    @Column({
        type: "varchar",
        length: 64,
        comment: "admin login username",
    })
    username: string;

    @Column({
        type: "varchar",
        length: 128,
        comment: "password hash",
    })
    password_hash: string;

    @Column({
        type: "varchar",
        length: 64,
        comment: "password salt",
    })
    password_salt: string;

    @Index("admin_accounts_is_delete_index")
    @Column({
        default: false,
    })
    is_delete: boolean;

    @Column({
        type: "datetime",
        precision: 3,
        nullable: true,
        comment: "last login time",
    })
    last_login_at: Date | null;
}
