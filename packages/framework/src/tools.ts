// The agent's tool map: when each tool should fire, what must come first, and the failure to catch.
// Tool metrics are scored against this map and tool calls feed the tagging rules.

export type ToolSpec = {
  name: string;
  shouldFire: string;
  mustComeFirst: string;
  failure: string;
  /** Tools whose successful result counts as a secured next step. */
  nextStep?: 'meeting' | 'callback' | 'document' | 'transfer' | 'note';
  /** Arguments the tool must carry to count as an accurate call. */
  requiredArgs?: string[];
  /** Agent claims that need this tool's confirmation first (gate G8). */
  claims?: RegExp;
};

export const TOOL_MAP: ToolSpec[] = [
  { name: 'get_project_details', shouldFire: 'Any project fact is about to be stated, or a cross-project question (“which have a 2BHK”)', mustComeFirst: '—', failure: 'A project fact, price or size stated with no tool output behind it' },
  { name: 'update_caller_details', shouldFire: 'The turn the caller gives a name, email, number or city', mustComeFirst: 'Email or number read back and confirmed', failure: 'Sent late or never; used for budget, bedrooms or location' },
  { name: 'send_broker_registration_link', shouldFire: 'Broker’s registration status is known', mustComeFirst: 'Broker persona confirmed; broker type asked', failure: 'Called for an investor; held until goodbye; “the link is on the way” with no channel named; signup link claimed for a registered broker', requiredArgs: ['registered'], claims: /registration link (is|has been) (sent|on its way)/i },
  { name: 'send_documents', shouldFire: 'A clear yes to a specific document offer', mustComeFirst: 'Interest in a specific project; allowed document type; channel known; read-back for a new number or email', failure: 'Unsolicited or duplicate send; unlisted type promised; one call per project when “all” was asked; “sent” said before the tool confirmed', nextStep: 'document', requiredArgs: ['channel'], claims: /\b(sent|on (its|their) way|in your (inbox|whatsapp))\b/i },
  { name: 'schedule_callback', shouldFire: 'Caller asks to be called later at a time', mustComeFirst: 'Time repeated back and confirmed', failure: 'Used for an advisor meeting; a time booked that the caller never said', nextStep: 'callback', requiredArgs: ['time'], claims: /\b(call(ing)? you back|callback (is )?(booked|scheduled))\b/i },
  { name: 'schedule_meeting', shouldFire: 'Meeting form plus day and time known (plus project for a site visit)', mustComeFirst: 'Online / office / site choice asked (investor); registration link sent first (broker)', failure: 'Wrong meeting_kind; fork skipped on a bare “site visit”; a second meeting instead of a move; a time stated that the tool did not confirm', nextStep: 'meeting', requiredArgs: ['meeting_kind', 'date', 'time'], claims: /\b(you'?re (all )?(booked|set)|(is|has been) booked|booked (you|it) (in|for))\b/i },
  { name: 'cancel_meeting', shouldFire: 'Caller clearly no longer wants the meeting', mustComeFirst: '—', failure: 'Cancelling on a maybe or on a reschedule; guessing which meeting', claims: /\b(cancell?ed (it|your|the)|(is|has been) cancell?ed)\b/i },
  { name: 'save_note', shouldFire: 'Caller wants a follow-up but won’t commit to a time or project; transfer fallback promise', mustComeFirst: '—', failure: 'Several notes for one ask; no note when nothing was booked', nextStep: 'note' },
  { name: 'request_live_transfer', shouldFire: 'Caller wants a person right now', mustComeFirst: 'Filler line spoken before the call', failure: 'Speaking after confirmed; ending the call after transfer_to; claiming the team is unavailable after transfer_to', nextStep: 'transfer' },
  { name: 'transfer_to_number', shouldFire: 'Immediately after a transfer_to result', mustComeFirst: 'request_live_transfer returned transfer_to', failure: 'Speaking first; a goodbye or end_call after it; not retried after an error', nextStep: 'transfer' },
  { name: 'end_call', shouldFire: 'Conclusion finished, time limit reached, or do-not-contact', mustComeFirst: 'Farewell spoken', failure: 'Ending while the caller is engaged; ending during a transfer; running past 955 seconds' },
];

export const TOOL_NAMES = TOOL_MAP.map((t) => t.name);
export const toolSpec = (name: string) => TOOL_MAP.find((t) => t.name === name);

/** Provider built-ins that map onto the framework's tool names. Extendable per deployment via settings. */
export const DEFAULT_TOOL_ALIASES: Record<string, string> = {
  transfer_call: 'transfer_to_number',
  bridge_transfer: 'transfer_to_number',
  transfer_to_agent: 'request_live_transfer',
  end_conversation: 'end_call',
  skip_turn: '',
  language_detection: '',
};

/** Tools whose arguments or confirmation define the call's next step. */
export const NEXT_STEP_TOOLS = TOOL_MAP.filter((t) => t.nextStep).map((t) => t.name);
