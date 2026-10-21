-- CreateTable
CREATE TABLE `Agent` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` ENUM('proxmox_node', 'linux_node') NOT NULL,
    `version` VARCHAR(191) NOT NULL DEFAULT '0.0.0',
    `presence` ENUM('ONLINE', 'UNREACHABLE', 'OFFLINE') NOT NULL DEFAULT 'OFFLINE',
    `lastSeenAt` DATETIME(3) NULL,
    `registeredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `maxConcurrency` INTEGER NOT NULL DEFAULT 4,
    `capabilities` JSON NOT NULL,
    `reportedRunning` INTEGER NOT NULL DEFAULT 0,
    `reportedQueued` INTEGER NOT NULL DEFAULT 0,
    `reportedCapacity` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Agent_presence_idx`(`presence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgentCredential` (
    `agentId` VARCHAR(191) NOT NULL,
    `secretCiphertext` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`agentId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `AgentNonce` (
    `id` VARCHAR(191) NOT NULL,
    `agentId` VARCHAR(191) NOT NULL,
    `nonce` VARCHAR(191) NOT NULL,
    `timestamp` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,

    INDEX `AgentNonce_expiresAt_idx`(`expiresAt`),
    UNIQUE INDEX `AgentNonce_agentId_nonce_key`(`agentId`, `nonce`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Cluster` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `type` ENUM('PROXMOX') NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Cluster_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProxmoxNode` (
    `id` VARCHAR(191) NOT NULL,
    `clusterId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `machineId` VARCHAR(191) NOT NULL,
    `agentId` VARCHAR(191) NULL,
    `version` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProxmoxNode_machineId_key`(`machineId`),
    INDEX `ProxmoxNode_agentId_idx`(`agentId`),
    UNIQUE INDEX `ProxmoxNode_clusterId_name_key`(`clusterId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Machine` (
    `id` VARCHAR(191) NOT NULL,
    `hostname` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `type` ENUM('PROXMOX_NODE', 'LXC', 'VM', 'PHYSICAL') NOT NULL,
    `status` ENUM('RUNNING', 'STOPPED', 'UNKNOWN', 'OFFLINE') NOT NULL,
    `metricsSource` ENUM('PROXMOX', 'LOCAL_AGENT') NOT NULL,
    `agentId` VARCHAR(191) NULL,
    `lastSeenAt` DATETIME(3) NULL,
    `lastStateChangeAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `hiddenAt` DATETIME(3) NULL,
    `details` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `Machine_agentId_idx`(`agentId`),
    INDEX `Machine_status_hiddenAt_idx`(`status`, `hiddenAt`),
    INDEX `Machine_type_idx`(`type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MachineProxmoxLink` (
    `machineId` VARCHAR(191) NOT NULL,
    `clusterId` VARCHAR(191) NOT NULL,
    `currentNodeId` VARCHAR(191) NULL,
    `vmid` INTEGER NOT NULL,
    `guestType` ENUM('LXC', 'QEMU') NOT NULL,

    INDEX `MachineProxmoxLink_currentNodeId_idx`(`currentNodeId`),
    UNIQUE INDEX `MachineProxmoxLink_clusterId_vmid_key`(`clusterId`, `vmid`),
    PRIMARY KEY (`machineId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Metric` (
    `id` VARCHAR(191) NOT NULL,
    `machineId` VARCHAR(191) NOT NULL,
    `timestamp` DATETIME(3) NOT NULL,
    `cpuUsage` DOUBLE NOT NULL,
    `memoryUsed` BIGINT NOT NULL,
    `memoryTotal` BIGINT NOT NULL,
    `diskUsed` BIGINT NULL,
    `diskTotal` BIGINT NULL,
    `networkRx` BIGINT NULL,
    `networkTx` BIGINT NULL,
    `uptime` BIGINT NULL,

    INDEX `Metric_machineId_timestamp_idx`(`machineId`, `timestamp`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UpdateSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `machineId` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `availableCount` INTEGER NOT NULL,
    `securityCount` INTEGER NULL,
    `requiresReboot` BOOLEAN NOT NULL DEFAULT false,
    `requiresConfirmation` BOOLEAN NOT NULL DEFAULT false,

    INDEX `UpdateSnapshot_machineId_createdAt_idx`(`machineId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `UpdatePackage` (
    `id` VARCHAR(191) NOT NULL,
    `snapshotId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `currentVersion` VARCHAR(191) NULL,
    `newVersion` VARCHAR(191) NULL,
    `architecture` VARCHAR(191) NULL,
    `changeType` VARCHAR(191) NOT NULL,
    `security` BOOLEAN NOT NULL DEFAULT false,

    INDEX `UpdatePackage_snapshotId_idx`(`snapshotId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Job` (
    `id` VARCHAR(191) NOT NULL,
    `parentId` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `category` ENUM('READ', 'WRITE', 'CRITICAL') NOT NULL,
    `executionKind` ENUM('PARENT', 'LEAF') NOT NULL,
    `agentId` VARCHAR(191) NULL,
    `machineId` VARCHAR(191) NULL,
    `targetType` VARCHAR(191) NOT NULL,
    `targetData` JSON NOT NULL,
    `status` ENUM('QUEUED', 'ASSIGNED', 'RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED', 'INTERRUPTED', 'UNKNOWN', 'CANCELLED', 'REQUIRES_CONFIRMATION') NOT NULL,
    `requestedBy` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `assignedAt` DATETIME(3) NULL,
    `dispatchedAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `acknowledgedAt` DATETIME(3) NULL,
    `resolvedExecutable` VARCHAR(191) NULL,
    `resolvedArguments` JSON NULL,
    `result` JSON NULL,
    `exitCode` INTEGER NULL,
    `durationMs` INTEGER NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,

    INDEX `Job_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `Job_agentId_status_idx`(`agentId`, `status`),
    INDEX `Job_machineId_status_idx`(`machineId`, `status`),
    INDEX `Job_parentId_idx`(`parentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `JobLog` (
    `id` VARCHAR(191) NOT NULL,
    `jobId` VARCHAR(191) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `timestamp` DATETIME(3) NOT NULL,
    `stream` ENUM('STDOUT', 'STDERR', 'SYSTEM') NOT NULL,
    `data` TEXT NOT NULL,

    INDEX `JobLog_jobId_sequence_idx`(`jobId`, `sequence`),
    UNIQUE INDEX `JobLog_jobId_sequence_key`(`jobId`, `sequence`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `Alert` (
    `id` VARCHAR(191) NOT NULL,
    `dedupeKey` VARCHAR(191) NOT NULL,
    `severity` ENUM('INFO', 'WARNING', 'CRITICAL') NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `message` TEXT NOT NULL,
    `machineId` VARCHAR(191) NULL,
    `agentId` VARCHAR(191) NULL,
    `clusterId` VARCHAR(191) NULL,
    `acknowledgedAt` DATETIME(3) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Alert_dedupeKey_key`(`dedupeKey`),
    INDEX `Alert_resolvedAt_idx`(`resolvedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `AgentCredential` ADD CONSTRAINT `AgentCredential_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `AgentNonce` ADD CONSTRAINT `AgentNonce_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProxmoxNode` ADD CONSTRAINT `ProxmoxNode_clusterId_fkey` FOREIGN KEY (`clusterId`) REFERENCES `Cluster`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProxmoxNode` ADD CONSTRAINT `ProxmoxNode_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProxmoxNode` ADD CONSTRAINT `ProxmoxNode_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Machine` ADD CONSTRAINT `Machine_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MachineProxmoxLink` ADD CONSTRAINT `MachineProxmoxLink_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MachineProxmoxLink` ADD CONSTRAINT `MachineProxmoxLink_clusterId_fkey` FOREIGN KEY (`clusterId`) REFERENCES `Cluster`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MachineProxmoxLink` ADD CONSTRAINT `MachineProxmoxLink_currentNodeId_fkey` FOREIGN KEY (`currentNodeId`) REFERENCES `ProxmoxNode`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Metric` ADD CONSTRAINT `Metric_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UpdateSnapshot` ADD CONSTRAINT `UpdateSnapshot_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UpdateSnapshot` ADD CONSTRAINT `UpdateSnapshot_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `UpdatePackage` ADD CONSTRAINT `UpdatePackage_snapshotId_fkey` FOREIGN KEY (`snapshotId`) REFERENCES `UpdateSnapshot`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Job` ADD CONSTRAINT `Job_parentId_fkey` FOREIGN KEY (`parentId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Job` ADD CONSTRAINT `Job_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Job` ADD CONSTRAINT `Job_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `JobLog` ADD CONSTRAINT `JobLog_jobId_fkey` FOREIGN KEY (`jobId`) REFERENCES `Job`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Alert` ADD CONSTRAINT `Alert_machineId_fkey` FOREIGN KEY (`machineId`) REFERENCES `Machine`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Alert` ADD CONSTRAINT `Alert_agentId_fkey` FOREIGN KEY (`agentId`) REFERENCES `Agent`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Alert` ADD CONSTRAINT `Alert_clusterId_fkey` FOREIGN KEY (`clusterId`) REFERENCES `Cluster`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
