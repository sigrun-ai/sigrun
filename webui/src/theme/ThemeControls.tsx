/**
 * ThemeControls (Task 25): the top bar's theme affordances — the light/dark
 * toggle and the accent picker (spec §6.1's "light/dark + accent theme
 * system"). Pure presentation over the {@link ThemeState} the parent owns.
 */

import { ACCENTS, type AccentName, type ThemeState } from "./useTheme";

export function ThemeControls(props: { theme: ThemeState }) {
	const { theme } = props;
	return (
		<span className="theme-controls">
			<select
				className="accent-picker"
				title="accent theme"
				value={theme.accent}
				onChange={(event) =>
					theme.setAccent(event.target.value as AccentName)
				}
			>
				{ACCENTS.map((accent) => (
					<option key={accent} value={accent}>
						{accent}
					</option>
				))}
			</select>
			<button
				type="button"
				className="theme-toggle"
				title="light/dark"
				onClick={() => theme.toggleTheme()}
			>
				◐ theme
			</button>
		</span>
	);
}
