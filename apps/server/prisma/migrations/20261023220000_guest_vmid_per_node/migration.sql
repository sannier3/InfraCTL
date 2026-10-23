-- Un VMID appartient à un nœud. Deux environnements peuvent réutiliser le même numéro.
ALTER TABLE `MachineProxmoxLink` DROP INDEX IF EXISTS `MachineProxmoxLink_clusterId_vmid_key`;
CREATE UNIQUE INDEX IF NOT EXISTS `MachineProxmoxLink_currentNodeId_vmid_key` ON `MachineProxmoxLink`(`currentNodeId`, `vmid`);
CREATE INDEX IF NOT EXISTS `MachineProxmoxLink_clusterId_vmid_idx` ON `MachineProxmoxLink`(`clusterId`, `vmid`);
