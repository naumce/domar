export default {
  app: { name: 'domar', loading: 'Loading…', save: 'Save', cancel: 'Cancel', create: 'Create', edit: 'Edit', delete: 'Delete', confirmDelete: 'Are you sure?', actions: 'Actions', search: 'Search', empty: 'No data', yes: 'Yes', no: 'No', error: 'Something went wrong' },
  nav: { dashboard: 'Dashboard', buildings: 'Buildings', services: 'Services', contacts: 'Contacts', invoices: 'Invoices', taxRates: 'Tax rates', settings: 'Settings', logout: 'Log out', portal: 'Owner portal' },
  auth: {
    login: 'Log in', register: 'Create account', tenantSlug: 'Organization (slug)', email: 'Email', password: 'Password', firstName: 'First name', lastName: 'Last name', orgName: 'Company name', noAccount: 'No account?', haveAccount: 'Already have an account?',
    errors: { invalid_credentials: 'Wrong organization, email or password.', slug_taken: 'That slug is already taken.', validation: 'Check the entered data.', generic: 'Something went wrong. Try again.' },
  },
  dashboard: { welcome: 'Welcome, {name}', buildings: 'Buildings', units: 'Units', contacts: 'Contacts' },
  taxRates: { title: 'Tax rates', name: 'Name', rate: 'Rate (%)', isDefault: 'Default', add: 'Add rate', makeDefault: 'Make default' },
  contacts: { title: 'Contacts', add: 'Add contact', kind: 'Kind', person: 'Person', company: 'Company', companyNumber: 'Company number', vatNumber: 'VAT number', phone: 'Phone', address: 'Address', notes: 'Notes' },
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
} as const;
