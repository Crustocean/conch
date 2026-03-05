/**
 * Simple unified diff generator for comparing file contents.
 * Used by both the workspace (view_diff) and the run timeline (tool output).
 */

/**
 * @param {string} path - File path for diff headers
 * @param {string} oldContent - Original file content (empty string for new files)
 * @param {string} newContent - New file content
 * @returns {string|null} Unified diff string, or null if no changes
 */
export function buildUnifiedDiff(path, oldContent, newContent) {
  if (oldContent === newContent) return null;
  const oldLines = oldContent ? oldContent.split('\n') : [];
  const newLines = newContent.split('\n');
  const out = [`--- a/${path}`, `+++ b/${path}`];
  if (!oldContent) {
    out.push(`@@ -0,0 +1,${newLines.length} @@`);
    newLines.forEach((l) => out.push(`+${l}`));
  } else {
    out.push(`@@ -1,${oldLines.length} +1,${newLines.length} @@`);
    const maxLen = Math.max(oldLines.length, newLines.length);
    for (let i = 0; i < maxLen; i++) {
      if (i >= oldLines.length) out.push(`+${newLines[i]}`);
      else if (i >= newLines.length) out.push(`-${oldLines[i]}`);
      else if (oldLines[i] !== newLines[i]) { out.push(`-${oldLines[i]}`); out.push(`+${newLines[i]}`); }
      else out.push(` ${oldLines[i]}`);
    }
  }
  return out.join('\n');
}
