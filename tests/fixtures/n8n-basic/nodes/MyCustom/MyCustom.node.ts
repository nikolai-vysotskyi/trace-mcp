import { INodeType, INodeTypeDescription } from 'n8n-workflow';

export class MyCustom implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'My Custom Node',
    name: 'myCustom',
    group: ['transform'],
    version: 1,
    description: 'A custom n8n node',
    defaults: { name: 'My Custom' },
    inputs: ['main'],
    outputs: ['main'],
    credentials: [
      { name: 'myCustomApi', required: true },
    ],
    properties: [
      { name: 'operation', displayName: 'Operation', type: 'options', options: [
        { name: 'create', value: 'create' },
        { name: 'delete', value: 'delete' },
      ] },
      { name: 'resource', displayName: 'Resource', type: 'string', default: '' },
    ],
  };
}
