-- L'index unique (clusterId, vmid) porte aussi la clé étrangère vers Cluster.
-- On retire d'abord cette contrainte, puis on rattache le VMID au nœud.
SET @guest_vmid_sql = (
  SELECT IF(
    (
      SELECT COUNT(*)
      FROM information_schema.statistics
      WHERE table_schema = DATABASE()
        AND table_name = 'MachineProxmoxLink'
        AND index_name = 'MachineProxmoxLink_clusterId_vmid_key'
    ) > 0,
    'ALTER TABLE `MachineProxmoxLink` DROP FOREIGN KEY `MachineProxmoxLink_clusterId_fkey`, DROP INDEX `MachineProxmoxLink_clusterId_vmid_key`, ADD INDEX `MachineProxmoxLink_clusterId_vmid_idx` (`clusterId`, `vmid`), ADD UNIQUE INDEX `MachineProxmoxLink_currentNodeId_vmid_key` (`currentNodeId`, `vmid`), ADD CONSTRAINT `MachineProxmoxLink_clusterId_fkey` FOREIGN KEY (`clusterId`) REFERENCES `Cluster`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE',
    'SELECT 1'
  )
);
PREPARE infra_guest_vmid FROM @guest_vmid_sql;
EXECUTE infra_guest_vmid;
DEALLOCATE PREPARE infra_guest_vmid;
