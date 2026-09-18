import { MarkDownRenderer } from '@openuidev/react-ui';
import { Renderer } from '@openuidev/react-lang';
import type { AnyLibrary } from '../catalog/registry.tsx';
import { RenderErrorBoundary } from '../components/RenderErrorBoundary.tsx';

/**
 * Body of one assistant message.
 *
 * **Why this exists at all.** `AgentInterface` has two ways of rendering an
 * answer. Given a `componentLibrary` it uses its GenUI path, which hands the
 * whole message to the OpenUI Lang `Renderer`; given neither a library nor an
 * override it renders the message as markdown. The GenUI path renders *nothing*
 * for ordinary prose — so an application that supplies a component library, as
 * this one must, silently loses every plain-language answer the agent gives.
 * That is what was happening here: the conversation showed the tool steps and an
 * empty bubble where the reply should have been.
 *
 * **Scope of this override.** It replaces the message *body* only, and only to
 * choose between the two renderers the library already provides, by the
 * library's own rule for what counts as OpenUI Lang markup. Everything else in
 * the chat stays the ready-made component: the thread list, the composer, the
 * streaming, the tool-call timeline (which `InterleavedTurn` draws outside the
 * message body and is therefore untouched), and the artifact workspace.
 *
 * **Limitation, stated plainly.** The library's own default body additionally
 * renders artifact `TimelineEntry` items for tool activity that matches a
 * registered artifact renderer. In the arrangement this application uses those
 * entries are drawn by `InterleavedTurn` alongside the timeline, so nothing is
 * lost here — but an installation that renders assistant messages outside a
 * tool turn would need to add them back.
 */

/**
 * The library's rule, mirrored: a response is OpenUI Lang when it carries an
 * `openui-lang` fence or a top-level `root =` assignment. Kept identical on
 * purpose — diverging would render markup as prose or prose as markup.
 */
export function isOpenUiLang(content: string): boolean {
  return content.includes('```openui-lang') || /(^|\n)\s*root\s*=/.test(content);
}

/** One piece of an answer: words to read, or a composition to render. */
export type MessagePart =
  | { kind: 'prose'; content: string }
  | { kind: 'openui'; content: string };

/**
 * Fenced composition: the one form in which an answer can carry both.
 *
 * Captured without the `s` flag so a message with two fences is split into two
 * compositions rather than one spanning everything between them.
 */
const OPENUI_FENCE = /```openui-lang\s*\n([\s\S]*?)(?:```|$)/g;

/**
 * Splits an answer into the parts it is actually made of.
 *
 * The rule above answers "is there markup in here", which is the question the
 * renderer choice needs — but answering it for the *whole* message is what made
 * a sentence of explanation disappear the moment the agent put a table under
 * it. One fenced composition anywhere turned the entire answer over to the
 * GenUI renderer, which draws the composition and nothing else, so the words
 * around it were dropped without a trace: not an error, not an empty bubble, a
 * confident answer with its explanation missing.
 *
 * So a fenced answer is split: the prose between the fences is prose and is
 * rendered as markdown, each fence is a composition and is rendered from the
 * catalog. An answer that is a bare `root =` assignment has no such boundary to
 * cut on and stays one composition, exactly as before.
 */
export function splitMessage(content: string): MessagePart[] {
  if (!content.includes('```openui-lang')) {
    return content.trim()
      ? [{ kind: isOpenUiLang(content) ? 'openui' : 'prose', content }]
      : [];
  }
  const parts: MessagePart[] = [];
  let at = 0;
  OPENUI_FENCE.lastIndex = 0;
  for (let m = OPENUI_FENCE.exec(content); m; m = OPENUI_FENCE.exec(content)) {
    const before = content.slice(at, m.index);
    if (before.trim()) parts.push({ kind: 'prose', content: before });
    if (m[1]?.trim()) parts.push({ kind: 'openui', content: m[1] });
    at = m.index + m[0].length;
  }
  const rest = content.slice(at);
  if (rest.trim()) parts.push({ kind: 'prose', content: rest });
  return parts;
}

export interface AssistantMessageProps {
  message: { content?: string | null };
  isStreaming?: boolean;
}

export function makeAssistantMessage(library: AnyLibrary) {
  return function PlatformAssistantMessage({ message, isStreaming }: AssistantMessageProps) {
    const content = message.content ?? '';
    if (!content) return null;
    const parts = splitMessage(content);
    return (
      <div className="pf-msg" data-testid="assistant-message">
        {parts.map((part, i) =>
          part.kind === 'openui' ? (
            /*
             * A composition that cannot be rendered is a readable failure in
             * the answer, not an answer that vanishes. Without the boundary a
             * throw from the renderer takes the whole conversation down, which
             * is the worst of the four outcomes this has to tell apart.
             */
            <RenderErrorBoundary
              key={i}
              label="odpowiedz"
              describe={(_name, msg) => `Opis interfejsu w odpowiedzi nie da sie wyrenderowac: ${msg}`}
            >
              <div data-testid="assistant-openui">
                <Renderer response={part.content} library={library as never} isStreaming={isStreaming} />
              </div>
            </RenderErrorBoundary>
          ) : (
            <div key={i} data-testid="assistant-prose">
              <MarkDownRenderer textMarkdown={part.content} />
            </div>
          ),
        )}
      </div>
    );
  };
}
