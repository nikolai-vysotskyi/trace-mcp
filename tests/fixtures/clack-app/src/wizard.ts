// @ts-nocheck
import * as p from '@clack/prompts';

export async function runSetup() {
  p.intro('Welcome to the setup wizard');

  const name = await p.text({
    message: 'Project name?',
    placeholder: 'my-project',
  });

  if (p.isCancel(name)) {
    p.outro('Setup cancelled');
    return;
  }

  const framework = await p.select({
    message: 'Choose a framework',
    options: [
      { value: 'react', label: 'React' },
      { value: 'vue', label: 'Vue' },
      { value: 'svelte', label: 'Svelte' },
    ],
  });

  const features = await p.multiselect({
    message: 'Select features',
    options: [
      { value: 'typescript', label: 'TypeScript' },
      { value: 'eslint', label: 'ESLint' },
      { value: 'prettier', label: 'Prettier' },
    ],
  });

  const confirmed = await p.confirm({
    message: 'Proceed with setup?',
  });

  const s = p.spinner();
  s.start('Creating project...');
  // simulate work
  s.stop('Project created!');

  p.outro('All done!');

  log.info('Setup complete');
  log.success(`Created ${name}`);
}
