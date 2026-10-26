// Expected path per scenario: a short sequence of checkpoints. A call scores the share of
// checkpoints it reached in order, and the first missed checkpoint is its deviation point.
//
// Each checkpoint names how it is detected: by a tool that returned successfully, by a code rule
// over the transcript, or by the judge when it needs the meaning of the words.

export type CheckpointDetect =
  | { by: 'tool'; tools: string[]; args?: Record<string, string | RegExp> }
  | { by: 'rule'; rule: 'persona_resolved' | 'discovery' | 'filler_before_transfer' | 'transfer_outcome' | 'short_call' | 'tool_confirmed_readback' | 'question_after_send' | 'no_further_pitch' }
  | { by: 'judge' };

export type Checkpoint = { id: string; label: string; detect: CheckpointDetect; hint?: string };

export const PATHS: Record<string, Checkpoint[]> = {
  S1: [
    { id: 'persona', label: 'Persona resolved', detect: { by: 'rule', rule: 'persona_resolved' } },
    { id: 'discovery', label: 'Discovery', detect: { by: 'rule', rule: 'discovery' } },
    { id: 'two_option', label: 'Two-option pitch', detect: { by: 'judge' }, hint: 'Two projects offered with a contrast, not a list' },
    { id: 'meeting_fork', label: 'Meeting fork', detect: { by: 'judge' }, hint: 'Online, office or site visit choice offered' },
    { id: 'booking', label: 'Booking', detect: { by: 'tool', tools: ['schedule_meeting'] } },
  ],
  S2: [
    { id: 'answer_tool', label: 'Answer from get_project_details', detect: { by: 'tool', tools: ['get_project_details'] } },
    { id: 'qualify', label: 'Qualify around it', detect: { by: 'judge' }, hint: 'A discovery question tied to the project asked about' },
    { id: 'next_step', label: 'Offer a next step', detect: { by: 'judge' }, hint: 'A meeting, document, callback or transfer offered' },
  ],
  S3: [
    { id: 'confirm', label: 'Confirm project and channel', detect: { by: 'judge' }, hint: 'Project and channel (WhatsApp or email) confirmed before sending' },
    { id: 'send', label: 'send_documents', detect: { by: 'tool', tools: ['send_documents'] } },
    { id: 'follow_up', label: 'One follow-up question', detect: { by: 'rule', rule: 'question_after_send' } },
  ],
  S4: [
    { id: 'repeat_time', label: 'Repeat the time back', detect: { by: 'judge' }, hint: 'The callback time repeated to the caller before booking' },
    { id: 'callback', label: 'schedule_callback', detect: { by: 'tool', tools: ['schedule_callback'] } },
  ],
  S5: [
    { id: 'filler', label: 'Filler line', detect: { by: 'rule', rule: 'filler_before_transfer' } },
    { id: 'request', label: 'request_live_transfer', detect: { by: 'tool', tools: ['request_live_transfer'] } },
    { id: 'outcome', label: 'Hand-over or graceful fallback', detect: { by: 'rule', rule: 'transfer_outcome' } },
  ],
  S6: [
    { id: 'identified', label: 'Reschedule or cancel identified', detect: { by: 'judge' }, hint: 'The agent confirms whether the caller wants to move or cancel, and which meeting' },
    { id: 'tool', label: 'schedule_meeting or cancel_meeting', detect: { by: 'tool', tools: ['schedule_meeting', 'cancel_meeting'] } },
    { id: 'confirmed', label: 'Change confirmed by the tool', detect: { by: 'rule', rule: 'tool_confirmed_readback' } },
  ],
  S7: [
    { id: 'type', label: 'Type asked', detect: { by: 'judge' }, hint: 'Agency or independent broker asked' },
    { id: 'status', label: 'Registration status known', detect: { by: 'judge' }, hint: 'Whether the broker is registered is established' },
    { id: 'link', label: 'Link tool called', detect: { by: 'tool', tools: ['send_broker_registration_link'] } },
    { id: 'brief', label: 'Brief given', detect: { by: 'judge' }, hint: 'A project brief grounded in get_project_details' },
    { id: 'bdm', label: 'BDM call offered', detect: { by: 'judge' }, hint: 'A call with the broker team offered or booked' },
  ],
  S8: [
    { id: 'ack', label: 'Acknowledge', detect: { by: 'judge' } },
    { id: 'alternative', label: 'One real alternative', detect: { by: 'judge' } },
    { id: 'soft_end', label: 'Soft end', detect: { by: 'judge' } },
    { id: 'stop', label: 'Stop after a second no', detect: { by: 'rule', rule: 'no_further_pitch' } },
  ],
  S9: [
    { id: 'ack', label: 'Acknowledge where things stand', detect: { by: 'judge' } },
    { id: 'objective', label: 'The objective', detect: { by: 'judge' }, hint: 'The objective from the opening context completed' },
  ],
  S10: [
    { id: 'accept', label: 'Accept the first time', detect: { by: 'judge' } },
    { id: 'dnc', label: 'Honour do-not-contact', detect: { by: 'rule', rule: 'no_further_pitch' } },
    { id: 'close', label: 'Courteous close', detect: { by: 'judge' } },
  ],
  S11: [
    { id: 'deflect', label: 'One-line deflection', detect: { by: 'judge' } },
    { id: 'redirect', label: 'Advisor or redirect', detect: { by: 'judge' } },
    { id: 'back', label: 'Back on track', detect: { by: 'judge' } },
  ],
  S12: [
    { id: 'quick', label: 'End or leave a message quickly', detect: { by: 'rule', rule: 'short_call' } },
  ],
};

/** Discovery fields per persona path (Discovery coverage, qualified lead). */
export const INVESTOR_FIELDS = ['buy_intent', 'property_type', 'bedrooms', 'location', 'budget', 'timeline', 'must_haves', 'who_for'] as const;
/** The seven discovery fields the framework counts for investors (buy intent, type and bedrooms count as one each). */
export const INVESTOR_DISCOVERY: { id: string; label: string; fields: string[] }[] = [
  { id: 'buy_intent', label: 'Buy intent', fields: ['buy_intent'] },
  { id: 'type_bedrooms', label: 'Type and bedrooms', fields: ['property_type', 'bedrooms'] },
  { id: 'location', label: 'Location', fields: ['location'] },
  { id: 'budget', label: 'Budget', fields: ['budget'] },
  { id: 'timeline', label: 'Timeline', fields: ['timeline'] },
  { id: 'must_haves', label: 'Must-haves', fields: ['must_haves'] },
  { id: 'who_for', label: 'Who it’s for', fields: ['who_for'] },
];
export const BROKER_DISCOVERY: { id: string; label: string; fields: string[] }[] = [
  { id: 'broker_type', label: 'Broker type', fields: ['broker_type'] },
  { id: 'registration', label: 'Registration', fields: ['registration'] },
  { id: 'project_interest', label: 'Project interest', fields: ['project_interest'] },
];

export const FIELD_LABELS: Record<string, string> = {
  persona: 'Persona', name: 'Name', email: 'Email', phone: 'Phone', city: 'City',
  buy_intent: 'Buy intent', property_type: 'Property type', bedrooms: 'Bedrooms', location: 'Location',
  budget: 'Budget', timeline: 'Timeline', must_haves: 'Must-haves', who_for: 'Who it’s for',
  broker_type: 'Broker type', registration: 'Registration', project_interest: 'Project interest',
};
