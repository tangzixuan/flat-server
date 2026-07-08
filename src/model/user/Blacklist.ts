import { Column, Entity, Index } from "typeorm";
import { Content } from "../Content";

@Entity({
    name: "user_blacklist",
})
export class UserBlacklistModel extends Content {
    @Index("user_blacklist_user_uuid_index")
    @Column({
        type: "varchar",
        length: 40,
        nullable: true,
        comment: "banned user uuid, nullable if banned by phone/email only",
    })
    user_uuid: string | null;

    @Index("user_blacklist_phone_uindex", {
        unique: true,
    })
    @Column({
        type: "varchar",
        length: 50,
        nullable: true,
        comment: "banned phone number",
    })
    phone_number: string | null;

    @Index("user_blacklist_email_uindex", {
        unique: true,
    })
    @Column({
        type: "varchar",
        length: 100,
        nullable: true,
        comment: "banned email",
    })
    email: string | null;

    @Column({
        type: "varchar",
        length: 255,
        nullable: true,
        comment: "ban reason",
    })
    reason: string | null;

    @Column({
        type: "varchar",
        length: 40,
        nullable: true,
        comment: "operator (admin user uuid or system name)",
    })
    operator: string | null;

    @Index("user_blacklist_is_delete_index")
    @Column({
        default: false,
    })
    is_delete: boolean;
}
