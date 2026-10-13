// Puppeteer has no public synchronous target-ID accessor for targetFilter.
// Keep this compatibility seam narrow and fail closed when the pinned client changes.
export function targetIdentity(target) {
  if (typeof target._targetId !== "string" || !target._targetId) throw new Error("Unsupported Puppeteer target identity; browser actions were not started.");
  return target._targetId;
}

export function trackPopup(info, owned, initial, primaryId) {
  if (info.type !== "page" || !owned.has(info.openerId) || initial.has(info.targetId)) return false;
  // Chrome's inspect bridge can also expose aliases of the already-owned page.
  if (info.targetId === primaryId || info.targetId.endsWith(":" + primaryId)) return false;
  return info.targetId !== info.openerId;
}
