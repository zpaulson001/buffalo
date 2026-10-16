import { defaultHighlightStyle, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const base = EditorView.theme({
	'&': { height: '100%', fontSize: '13px' },
	'.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }
});

export const lightTheme: Extension = [
	base,
	syntaxHighlighting(defaultHighlightStyle, { fallback: true })
];

const BG = '#0b0f1a';
const PANEL = '#111827';
const BORDER = '#374151';
const TEXT = '#e5e7eb';

const darkChrome = EditorView.theme(
	{
		'&': { color: TEXT, backgroundColor: BG },
		'.cm-content': { caretColor: TEXT },
		'.cm-gutters': { backgroundColor: BG, color: '#6b7280', border: 'none' },
		'.cm-foldPlaceholder': { backgroundColor: '#1f2937', border: 'none', color: '#9ca3af' },
		'.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
			backgroundColor: '#264f78'
		},
		'.cm-selectionMatch': { backgroundColor: '#3b82f633' },
		'.cm-searchMatch': { backgroundColor: '#8a6d1f66', outline: 'none' },
		'.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: '#b9922f99' },
		'.cm-panels': { backgroundColor: PANEL, color: TEXT },
		'.cm-panels.cm-panels-top': { borderBottom: `1px solid ${BORDER}` },
		'.cm-panel.cm-search label': { color: TEXT },
		'.cm-textfield': { backgroundColor: BG, color: TEXT, border: `1px solid ${BORDER}` },
		'.cm-button': {
			backgroundImage: 'none',
			backgroundColor: '#1f2937',
			color: TEXT,
			border: `1px solid ${BORDER}`
		},
		'.cm-panel.cm-search [name=close]': { color: TEXT }
	},
	{ dark: true }
);

const darkHighlight = HighlightStyle.define([
	{ tag: [t.comment, t.lineComment, t.blockComment], color: '#8b949e', fontStyle: 'italic' },
	{ tag: [t.string, t.special(t.string)], color: '#a5d6ff' },
	{ tag: [t.number, t.bool, t.null, t.atom], color: '#79c0ff' },
	{ tag: [t.propertyName, t.attributeName], color: '#7ee787' },
	{ tag: [t.keyword, t.operatorKeyword], color: '#ff7b72' },
	{ tag: [t.typeName, t.className], color: '#ffa657' },
	{ tag: [t.bracket, t.brace, t.squareBracket, t.punctuation], color: '#9ca3af' }
]);

export const darkTheme: Extension = [base, darkChrome, syntaxHighlighting(darkHighlight)];
