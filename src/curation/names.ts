const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Skill names are also their directory names: reject, never normalize. */
export function validSkillName(name: string): boolean {
	return SKILL_NAME.test(name);
}
