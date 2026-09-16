import { MarkDownRenderer } from '@openuidev/react-ui';
import { Renderer } from '@openuidev/react-lang';
import type { AnyLibrary } from '../catalog/registry.tsx';

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

export interface AssistantMessageProps {
  message: { content?: string | null };
  isStreaming?: boolean;
}

export function makeAssistantMessage(library: AnyLibrary) {
  return function PlatformAssistantMessage({ message, isStreaming }: AssistantMessageProps) {
    const content = message.content ?? '';
    if (!content) return null;
    return (
      <div className="pf-msg" data-testid="assistant-message">
        {isOpenUiLang(content) ? (
          <Renderer response={content} library={library as never} isStreaming={isStreaming} />
        ) : (
          <MarkDownRenderer textMarkdown={content} />
        )}
      </div>
    );
  };
}
