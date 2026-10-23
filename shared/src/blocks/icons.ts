/**
 * The named icons (UI-blocks spec §10.2): a CLOSED set of 49 names.
 *
 * The webui draws them from a bundled subset of Lucide; the TUI maps
 * each name to a Unicode glyph with an ASCII fallback. An unknown icon
 * name fails validation (U0 Task 2) — `IconName` is the literal union,
 * so a typo is a type error wherever the contract is used literally.
 */

/** The v1 icon set, exactly as spec §10.2 pins it. */
export const ICON_NAMES = [
	// navigation and actions
	"add",
	"edit",
	"delete",
	"refresh",
	"search",
	"filter",
	"share",
	"copy",
	"link",
	"external",
	"more",
	"check",
	"close",
	"drag",
	// objects
	"file",
	"folder",
	"calendar",
	"clock",
	"user",
	"users",
	"tag",
	"list",
	"board",
	"chart",
	"image",
	"book",
	"cart",
	"home",
	"bell",
	"lock",
	"key",
	// status
	"info",
	"warn",
	"error",
	"success",
	"pending",
	"running",
	// weather
	"sun",
	"moon",
	"cloud",
	"cloud-sun",
	"cloud-rain",
	"cloud-snow",
	"cloud-lightning",
	"fog",
	"wind",
	"droplets",
	"thermometer",
	"umbrella",
] as const;

/** One name from the closed set. */
export type IconName = (typeof ICON_NAMES)[number];
