const ptyIdsPendingTransferAttach = new Set<string>()

export function markPtyForTransferAttach(ptyId: string): void {
  ptyIdsPendingTransferAttach.add(ptyId)
}

export function shouldAttachTransferredPty(ptyId: string): boolean {
  return ptyIdsPendingTransferAttach.has(ptyId)
}

export function clearPtyTransferAttachMark(ptyId: string): void {
  ptyIdsPendingTransferAttach.delete(ptyId)
}

export function clearPtyTransferAttachMarks(): void {
  ptyIdsPendingTransferAttach.clear()
}
