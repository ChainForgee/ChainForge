export function formatStatus(status: string): string {
  const map: Record<string, string> = {
    requested: 'Requested',
    verified: 'Verified',
    approved: 'Approved',
    disbursed: 'Disbursed',
    archived: 'Archived',
    draft: 'Draft',
    active: 'Active',
    paused: 'Paused',
    completed: 'Completed',
  };
  return map[status] ?? status.charAt(0).toUpperCase() + status.slice(1);
}

export function getStatusTransitionMessage(entityType: 'Campaign' | 'Claim', oldStatus: string, newStatus: string): string {
  return `${entityType} status changed from ${formatStatus(oldStatus)} to ${formatStatus(newStatus)}.`;
}
