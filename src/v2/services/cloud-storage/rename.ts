import { createLoggerService } from "../../../logger";
import { EntityManager } from "typeorm";
import { CloudStorageInfoService } from "./info";
import { FileResourceType } from "../../../model/cloudStorage/Constants";
import { ErrorCode } from "../../../ErrorCode";
import { FError } from "../../../error/ControllerError";
import { CloudStorageDirectoryService } from "./directory";

export class CloudStorageRenameService {
    private readonly logger = createLoggerService<"cloudStorageRename">({
        serviceName: "cloudStorageRename",
        requestID: this.reqID,
    });

    constructor(
        private readonly reqID: string,
        private readonly DBTransaction: EntityManager,
        private readonly userUUID: string,
    ) {}

    public async rename(fileUUID: string, newName: string): Promise<void> {
        const cloudStorageInfoSvc = new CloudStorageInfoService(
            this.reqID,
            this.DBTransaction,
            this.userUUID,
        );

        const filesInfo = await cloudStorageInfoSvc.findFilesInfo();

        if (filesInfo.size === 0) {
            this.logger.info("cloud storage is empty");
            throw new FError(ErrorCode.FileNotFound);
        }

        const fileInfo = filesInfo.get(fileUUID);

        if (fileInfo === undefined) {
            this.logger.info("file not found");
            throw new FError(ErrorCode.FileNotFound);
        }

        if (fileInfo.resourceType === FileResourceType.Directory) {
            await new CloudStorageDirectoryService(
                this.reqID,
                this.DBTransaction,
                this.userUUID,
            ).rename(filesInfo, fileUUID, newName);
        }

        // TODO: implement rename for file
    }
}