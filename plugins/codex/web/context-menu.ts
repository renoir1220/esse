export interface ContextMenuPoint {
  left: number;
  top: number;
}

export function contextMenuPoint(clientX: number, clientY: number, menuWidth: number, menuHeight: number, viewportWidth: number, viewportHeight: number, margin = 8): ContextMenuPoint {
  const availableWidth = Math.max(0, viewportWidth - menuWidth - margin);
  const availableHeight = Math.max(0, viewportHeight - menuHeight - margin);
  return {
    left: Math.max(margin, Math.min(clientX, availableWidth)),
    top: Math.max(margin, Math.min(clientY, availableHeight))
  };
}
