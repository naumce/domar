export default {
  app: { name: 'domar', loading: 'Loading…', save: 'Save', cancel: 'Cancel', create: 'Create', edit: 'Edit', delete: 'Delete', confirmDelete: 'Are you sure?', actions: 'Actions', search: 'Search', empty: 'No data', yes: 'Yes', no: 'No', error: 'Something went wrong' },
  nav: { dashboard: 'Dashboard', buildings: 'Buildings', services: 'Services', contacts: 'Contacts', invoices: 'Invoices', payments: 'Payments', taxRates: 'Tax rates', settings: 'Settings', logout: 'Log out', portal: 'Owner portal' },
  auth: {
    login: 'Log in', register: 'Create account', tenantSlug: 'Organization (slug)', email: 'Email', password: 'Password', firstName: 'First name', lastName: 'Last name', orgName: 'Company name', noAccount: 'No account?', haveAccount: 'Already have an account?',
    errors: { invalid_credentials: 'Wrong organization, email or password.', slug_taken: 'That slug is already taken.', validation: 'Check the entered data.', generic: 'Something went wrong. Try again.' },
  },
  dashboard: { welcome: 'Welcome, {name}', buildings: 'Buildings', units: 'Units', owners: 'Owners', billed: 'Billed this month', unpaid: 'Unpaid invoices', paid: 'Paid this month', outstanding: 'Outstanding' },
  taxRates: { title: 'Tax rates', name: 'Name', rate: 'Rate (%)', isDefault: 'Default', add: 'Add rate', makeDefault: 'Make default' },
  contacts: { title: 'Contacts', add: 'Add contact', kind: 'Kind', person: 'Person', company: 'Company', companyNumber: 'Company number', vatNumber: 'VAT number', phone: 'Phone', address: 'Address', notes: 'Notes', statement: 'Statement', balance: 'Balance', allBuildings: 'All buildings', date: 'Date' },
  buildings: {
    title: 'Buildings', add: 'Add building', name: 'Name', address: 'Address', city: 'City', postalCode: 'Postal code', representative: 'Representative', none: '— none —', shareBasis: 'Share basis',
    shareBasisOptions: { area: 'By area (m²)', equal: 'Equal', custom: 'Ownership share' }, regularFundAccount: 'Regular fund account', reserveFundAccount: 'Reserve fund account', unitCount: 'Units',
  },
  units: {
    title: 'Units', add: 'Add unit', label: 'Label', floor: 'Floor', kind: 'Kind', areaM2: 'Area (m²)', ownershipShare: 'Ownership share (0–1, e.g. 0.0125)', owner: 'Owner', attachedTo: 'Attached to', notAttached: '— billed separately —',
    kinds: { apartment: 'Apartment', commercial: 'Commercial', parking: 'Parking', storage: 'Storage', other: 'Other' },
    errors: { label_taken: 'A unit with that label already exists.', invalid_attachment: 'Can only attach to an apartment or commercial unit in the same building.', invalid_reference: 'The selected contact does not exist.' },
  },
  portal: { title: 'Owner portal', comingSoon: 'Coming soon.' },
  services: {
    title: 'Services', add: 'Add service', name: 'Name', category: 'Category', pricing: 'Pricing model',
    pricingOptions: { fixed_per_unit: 'Fixed per unit', per_m2: 'Per m²', shared_total: 'Shared total (split)' },
    defaultPrice: 'Default price', taxRate: 'Tax rate', noTax: 'No tax', recurring: 'Recurring', oneTime: 'One-time', appliesTo: 'Applies to', allKinds: 'All kinds',
  },
  billing: {
    regular: 'Regular fund', reserve: 'Reserve fund', fund: 'Fund', amount: 'Amount', quantity: 'Quantity', unitPrice: 'Unit price', tax: 'Tax', total: 'Total', subtotal: 'Subtotal',
    previousBalance: 'Previous balance', amountDue: 'Amount due', buildingWide: 'Building-wide', ownerShare: 'Your share', description: 'Description', period: 'Period', status: 'Status',
    paid: 'Paid', outstanding: 'Outstanding',
  },
  buildingServices: {
    title: 'Recurring services', attach: 'Attach recurring service', frequency: 'Frequency', monthly: 'Monthly', everyN: 'Every N months', intervalMonths: 'Interval (months)',
    startsPeriod: 'Starts period', endsPeriod: 'Ends period', overridePrice: 'Price for this building (optional)', detach: 'Detach', alreadyAttached: 'This service is already attached.',
  },
  reserveFund: {
    title: 'Reserve fund', basis: 'Basis', perUnit: 'Per unit', perM2: 'Per m²', active: 'Active', balance: 'Balance', billed: 'Billed to owners',
    openingBalance: 'Opening balance', addOpening: 'Enter opening balance', expenses: 'Expenses', addExpense: 'Record expense', supplier: 'Supplier', paidAt: 'Paid on',
    void: 'Void', voided: 'Voided', transactions: 'Transactions', voidReason: 'Reason for voiding',
    kind: { opening: 'Opening balance', expense: 'Expense', adjustment: 'Adjustment', payment: 'Payment', charge: 'Charge' },
  },
  periods: {
    title: 'Periods', create: 'New period', exists: 'Period already exists.', managementFee: 'Management fee (per unit)', managementFeeTax: 'Management fee tax', numbering: 'Numbering',
    prefix: 'Prefix', suffix: 'Suffix', lines: 'Lines', addLine: 'Add line', fromService: 'From service', auto: 'Auto', manual: 'Manual', note: 'Note (required for auto lines)',
    refresh: 'Refresh auto lines', generate: 'Generate invoices', regenerate: 'Regenerate', deleteDrafts: 'Delete drafts', publish: 'Publish all',
    publishConfirm: 'Published invoices cannot be deleted. Continue?', warnings: 'Warnings', noteRequired: 'Enter a note to edit an automatic line.', nothingToPublish: 'No drafts to publish.', editSettings: 'Edit settings',
    warning: {
      missing_area: 'Unit {unit} has no area — not included in the m² allocation.', missing_share: 'Unit {unit} has no ownership share.',
      no_owner: 'Unit {unit} has no owner — not invoiced.', no_weight: 'Line has no units to allocate to — skipped.',
      target_no_owner: 'Unit {unit} is attached to a unit without an owner — not invoiced.', no_units: 'A line applies to no unit — omitted.',
    },
    status: { open: 'Open', generated: 'Drafts', published: 'Published' },
    invoices: 'Invoices', locked: 'The period is published and can no longer be changed.',
  },
  invoices: {
    title: 'Invoices', number: 'Number', owner: 'Owner', building: 'Building',
    status: { draft: 'Draft', published: 'Published', partially_paid: 'Partially paid', paid: 'Paid', cancelled: 'Cancelled' },
    openHtml: 'Open (HTML)', downloadPdf: 'Download PDF', deleteDraft: 'Delete draft', reserveBalance: 'Building reserve fund balance',
    issued: 'Issued', due: 'Due', units: 'Units',
    lineKind: { service: 'Service', manual: 'Line item', reserve_fund: 'Reserve fund', management_fee: 'Management' },
  },
  payments: {
    title: 'Payments', record: 'Record payment', amount: 'Amount', method: 'Method',
    methods: { cash: 'Cash', bank_transfer: 'Bank transfer', card: 'Card', cheque: 'Cheque', other: 'Other' },
    paidAt: 'Payment date', reference: 'Reference', note: 'Note', void: 'Void', voidReason: 'Void reason',
    status: { completed: 'Completed', voided: 'Voided' },
    received: 'Received', count: 'Payments', voidedCount: 'Voided', from: 'From', to: 'To', none: 'No payments', onAccount: 'On account (no invoice)',
  },
  statements: {
    title: 'Statements', upload: 'Import statement', file: 'File (MT940 or CSV)', lines: 'Lines', imported: 'Imported', matched: 'Matched', skipped: 'Skipped (duplicates)',
    status: { unmatched: 'Unmatched', suggested: 'Suggested', matched: 'Matched', ignored: 'Ignored' },
    confirm: 'Confirm', ignore: 'Ignore', unmatch: 'Unmatch', suggested: 'Suggested invoice', chooseInvoice: 'Choose invoice', warnings: 'Import warnings', counterparty: 'Counterparty',
    unknownFormat: 'File format not recognised (MT940 or CSV with date and amount columns).',
  },
  openingBalances: {
    title: 'Opening balances', owner: 'Owner', regular: 'Regular fund', reserve: 'Reserve fund', balance: 'Balance',
    alreadyEntered: 'Already entered', amount: 'New amount', fund: 'Fund', save: 'Save balances', saved: 'Opening balances booked.',
    publishedWarning: 'This building already has a published period. Entering opening balances rewrites history — confirm below.',
    force: 'Book anyway', empty: 'This building has no units with an owner.',
    errors: {
      period_published: 'This building has a published period. Tick “Book anyway”.',
      invalid_reference: 'The selected owner does not exist in this organization.',
      invalid_amount: 'Enter a non-zero amount.',
    },
  },
  imports: {
    title: 'Import', file: 'CSV file', mode: 'Existing labels', modeFail: 'Stop', modeSkip: 'Skip',
    preview: 'Preview', commit: 'Import', template: 'Download template', errors: 'File errors', line: 'Line',
    conflicts: 'Existing labels', chooseFile: 'Choose a file.',
    counts: { units: 'Units', contacts: 'New / existing contacts', balances: 'Opening balances', conflicts: 'Conflicts' },
    done: 'Imported {units} units, {contacts} new contacts and {balances} opening balances.',
    failure: {
      label_conflict: 'These units already exist: {labels}. Choose “skip” or change the labels.',
      period_published: 'This building has a published period, so opening balances cannot be imported.',
      too_many_rows: 'The file has more than 5000 rows.',
    },
  },
  import: {
    force: 'Enter opening balances despite a published period',
    errors: { period_published: 'The building has a published period; opening balances need confirmation.' },
  },
  settings: {
    title: 'Organization settings', timezone: 'Timezone', bankName: 'Bank', bankAccount: 'Account', companyNumber: 'Company number', vatNumber: 'VAT number', saved: 'Saved.',
  },
  users: {
    title: 'Users', add: 'Add user', role: 'Role', active: 'Active', inactive: 'Inactive',
    activate: 'Activate', deactivate: 'Deactivate', resetPassword: 'Reset password',
    tempPassword: 'Temporary password', tempPasswordHint: 'Write it down now — it will not be shown again.',
    copy: 'Copy', copied: 'Copied', dismiss: 'Close', self: 'You',
    confirmReset: 'A new temporary password will be generated and the user signed out. Continue?',
    roles: { owner: 'Owner', accountant: 'Accountant', technician: 'Technician', readonly: 'Read only' },
    errors: {
      email_taken: 'A user with that email already exists.',
      last_owner: 'The last active owner cannot be deactivated or given another role.',
      forbidden: 'Only an owner can manage users.',
    },
  },
  password: {
    change: 'Change password', current: 'Current password', new: 'New password', changed: 'Password changed.',
    errors: { invalid_credentials: 'The current password is wrong.', validation: 'The new password must be at least 10 characters.' },
  },
  ledger: {
    kind: { charge: 'Charge', payment: 'Payment', adjustment: 'Adjustment', opening: 'Opening balance', expense: 'Expense' },
  },
} as const;
