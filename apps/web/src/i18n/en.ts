export default {
  app: { name: 'domar', loading: 'Loading…', save: 'Save', cancel: 'Cancel', create: 'Create', edit: 'Edit', delete: 'Delete', confirmDelete: 'Are you sure?', actions: 'Actions', search: 'Search', empty: 'No data', yes: 'Yes', no: 'No', error: 'Something went wrong' },
  nav: { dashboard: 'Dashboard', buildings: 'Buildings', contacts: 'Contacts', taxRates: 'Tax rates', settings: 'Settings', logout: 'Log out', portal: 'Owner portal' },
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
} as const;
