/**
 * FilePreview (Task 24): the read-only preview under the workspace tree.
 *
 * `client.readFile(id, path)` returns the §5 files/content shape: text when
 * the bytes are strictly valid UTF-8, else base64. Text renders in a
 * `<pre>`; a binary payload renders a size/type NOTE (never the inline
 * base64 — preview polish like image rendering is deliberately trailing,
 * spec §6.1). A failed read (404, 413 file_too_large over the 1 MiB cap)
 * surfaces fail-loud via `role="alert"`.
 */

import { useEffect, useState } from "react";
import type { SigrunClient } from "../api";

type PreviewState =
	| { readonly kind: "loading" }
	| { readonly kind: "text"; readonly content: string; readonly size: number }
	| { readonly kind: "binary"; readonly size: number }
	| { readonly kind: "error"; readonly message: string };

export function FilePreview(props: {
	readonly client: SigrunClient;
	readonly conversationId: number;
	readonly path: string;
}) {
	const { client, conversationId, path } = props;
	const [state, setState] = useState<PreviewState>({ kind: "loading" });

	useEffect(() => {
		let cancelled = false;
		setState({ kind: "loading" });
		client
			.readFile(conversationId, path)
			.then((response) => {
				if (cancelled) return;
				setState(
					response.encoding === "text"
						? {
								kind: "text",
								content: response.content,
								size: response.size,
							}
						: { kind: "binary", size: response.size },
				);
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				setState({
					kind: "error",
					message: cause instanceof Error ? cause.message : String(cause),
				});
			});
		return () => {
			cancelled = true;
		};
	}, [client, conversationId, path]);

	return (
		<div className="file-preview" data-path={path}>
			<div className="file-preview-path">{path}</div>
			{state.kind === "loading" && (
				<p className="file-preview-loading">loading…</p>
			)}
			{state.kind === "text" && (
				<pre className="file-preview-content">{state.content}</pre>
			)}
			{state.kind === "binary" && (
				<p className="file-preview-binary">
					binary file — {state.size} bytes (no preview)
				</p>
			)}
			{state.kind === "error" && <p role="alert">{state.message}</p>}
		</div>
	);
}
