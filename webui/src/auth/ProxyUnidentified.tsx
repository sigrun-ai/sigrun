/**
 * Proxy-only auth has no browser credential form: when the proxy identity
 * does not produce a session, explain the operator action and offer a reload.
 * Server wire codes stay in the gate; this component renders only fixed copy.
 */

export interface ProxyUnidentifiedProps {
	readonly cause: "unidentified" | "invalid_username" | "not_provisioned";
	readonly context: "boot" | "session_ended" | "onboarding";
	readonly reload?: () => void;
}

export function ProxyUnidentified(props: ProxyUnidentifiedProps) {
	const { cause, context } = props;
	const reload = props.reload ?? (() => location.reload());
	return (
		<div className="auth-screen" data-auth-screen="proxy-unidentified">
			<div className="auth-card">
				<h1>Sign-in proxy required</h1>
				{context === "session_ended" && (
					<p className="auth-message">Your session ended.</p>
				)}
				{cause === "unidentified" ? (
					<>
						<p className="auth-message">
							This sigrun runs behind a sign-in proxy, but the proxy&apos;s
							identity didn&apos;t reach sigrun.
						</p>
						<p>
							The proxy&apos;s address may be missing from trustedProxies, or
							the proxy may not be forwarding the identity header. The operator
							can see the reason in the server log.
						</p>
					</>
				) : cause === "invalid_username" ? (
					<p className="auth-message">
						The proxy supplied an invalid username: the proxy&apos;s
						username has no usable characters.
					</p>
				) : (
					<p className="auth-message">
						Your account doesn&apos;t exist and auto-provisioning is off. Ask the
						admin to create your account.
					</p>
				)}
				<button type="button" className="auth-submit" onClick={reload}>
					Reload
				</button>
			</div>
		</div>
	);
}
