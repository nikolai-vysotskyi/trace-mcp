// @ts-nocheck
import { Command } from 'commander';

const program = new Command('my-cli');

program
  .name('my-cli')
  .description('A sample CLI tool')
  .version('1.0.0');

program
  .command('init <project>')
  .description('Initialize a new project')
  .option('-t, --template <name>', 'project template')
  .option('--no-git', 'skip git init')
  .action((project, options) => {
    console.log(`Initializing ${project}`);
  });

program
  .command('build')
  .description('Build the project')
  .option('-w, --watch', 'watch mode')
  .option('-o, --output <dir>', 'output directory')
  .action((options) => {
    console.log('Building...');
  });

program
  .command('deploy <environment>')
  .description('Deploy to an environment')
  .option('--dry-run', 'simulate deployment')
  .argument('[tag]', 'deployment tag')
  .action((env, tag, options) => {
    console.log(`Deploying to ${env}`);
  });

program.parse();
