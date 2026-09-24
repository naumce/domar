import { config } from '@vue/test-utils';

// Stubbed components (e.g. `stubs: { RouterLink: true }`) still render their default slot,
// so text assertions on rows that wrap their label in a RouterLink keep working under a stub.
config.global.renderStubDefaultSlot = true;
