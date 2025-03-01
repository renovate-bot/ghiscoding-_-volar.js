import * as vscode from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { FileSystemHost, LanguageServerInitializationOptions, LanguageServerPlugin, RuntimeEnvironment, ServerMode } from '../types';
import { createCancellationTokenHost } from './cancellationPipe';
import { createConfigurationHost } from './configurationHost';
import { createDocuments } from './documents';
import { setupCapabilities } from './utils/registerFeatures';
import { createWorkspaces } from './workspaces';
import * as l10n from '@vscode/l10n';

export interface ServerContext {
	connection: vscode.Connection,
	runtimeEnv: RuntimeEnvironment,
	plugins: LanguageServerPlugin[],
}

export function startCommonLanguageServer(context: ServerContext) {

	let initParams: vscode.InitializeParams;
	let options: LanguageServerInitializationOptions;
	let roots: URI[] = [];
	let fsHost: FileSystemHost | undefined;
	let projects: ReturnType<typeof createWorkspaces> | undefined;
	let configurationHost: ReturnType<typeof createConfigurationHost> | undefined;
	let plugins: ReturnType<LanguageServerPlugin>[];

	const documents = createDocuments(context.connection);

	context.connection.onInitialize(async _params => {

		initParams = _params;
		options = initParams.initializationOptions;
		plugins = context.plugins.map(plugin => plugin(options));

		if (options.l10n) {
			await l10n.config({ uri: options.l10n.location });
		}

		if (initParams.capabilities.workspace?.workspaceFolders && initParams.workspaceFolders) {
			roots = initParams.workspaceFolders.map(folder => URI.parse(folder.uri));
		}
		else if (initParams.rootUri) {
			roots = [URI.parse(initParams.rootUri)];
		}
		else if (initParams.rootPath) {
			roots = [URI.file(initParams.rootPath)];
		}

		const result: vscode.InitializeResult = {
			capabilities: {
				textDocumentSync: (options.textDocumentSync as vscode.TextDocumentSyncKind) ?? vscode.TextDocumentSyncKind.Incremental,
			},
		};

		configurationHost = initParams.capabilities.workspace?.configuration ? createConfigurationHost(initParams, context.connection) : undefined;

		setupCapabilities(initParams.capabilities, result.capabilities, options, plugins, getSemanticTokensLegend());
		await createLanguageServiceHost();

		try {
			// show version on LSP logs
			const packageJson = require('../package.json');
			result.serverInfo = {
				name: packageJson.name,
				version: packageJson.version,
			};
		} catch { }

		for (const plugin of plugins) {
			plugin.onInitialize?.(result);
		}

		return result;
	});
	context.connection.onInitialized(() => {

		fsHost?.ready(context.connection);
		configurationHost?.ready();

		if (initParams.capabilities.workspace?.workspaceFolders) {
			context.connection.workspace.onDidChangeWorkspaceFolders(e => {

				for (const folder of e.added) {
					projects?.add(URI.parse(folder.uri));
				}

				for (const folder of e.removed) {
					projects?.remove(URI.parse(folder.uri));
				}
			});
		}

		if (
			options.serverMode !== ServerMode.Syntactic
			&& !options.disableFileWatcher
			&& initParams.capabilities.workspace?.didChangeWatchedFiles?.dynamicRegistration
		) {
			const exts = plugins.map(plugin => plugin.extensions.fileWatcher ?? []).flat();
			if (exts.length) {
				context.connection.client.register(vscode.DidChangeWatchedFilesNotification.type, {
					watchers: [
						{
							globPattern: `**/*.{${exts.join(',')}}`
						},
					]
				});
			}
		}
	});
	context.connection.onShutdown(async () => {
		if (projects) {
			for (const workspace of projects.workspaces) {
				(await workspace[1]).dispose();
			}
		}
	});
	context.connection.listen();

	async function createLanguageServiceHost() {

		const ts = options.typescript ? context.runtimeEnv.loadTypescript(options.typescript.tsdk) : undefined;
		fsHost = ts ? context.runtimeEnv.createFileSystemHost(ts, initParams.capabilities) : undefined;

		const tsLocalized = options.typescript && initParams.locale ? await context.runtimeEnv.loadTypescriptLocalized(options.typescript.tsdk, initParams.locale) : undefined;
		const cancelTokenHost = createCancellationTokenHost(options.cancellationPipeName);
		const _projects = createWorkspaces({
			server: context,
			fileSystemHost: fsHost,
			configurationHost,
			ts,
			tsLocalized,
			initParams: initParams,
			initOptions: options,
			documents,
			cancelTokenHost,
			plugins,
		});
		projects = _projects;

		for (const root of roots) {
			projects.add(root);
		}

		(await import('./features/customFeatures')).register(context.connection, projects);
		(await import('./features/languageFeatures')).register(
			context.connection,
			projects,
			initParams,
			cancelTokenHost,
			getSemanticTokensLegend(),
			context.runtimeEnv,
		);

		for (const plugin of plugins) {
			plugin.onInitialized?.(getLanguageService as any);
		}

		async function getLanguageService(uri: string) {
			const project = (await projects!.getProject(uri))?.project;
			return project?.getLanguageService();
		}
	}

	function getSemanticTokensLegend() {
		if (!options.semanticTokensLegend) {
			return standardSemanticTokensLegend;
		}
		return {
			tokenTypes: [...standardSemanticTokensLegend.tokenTypes, ...options.semanticTokensLegend.tokenTypes],
			tokenModifiers: [...standardSemanticTokensLegend.tokenModifiers, ...options.semanticTokensLegend.tokenModifiers],
		};
	}
}

// https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide#standard-token-types-and-modifiers
const standardSemanticTokensLegend: vscode.SemanticTokensLegend = {
	tokenTypes: [
		'namespace',
		'class',
		'enum',
		'interface',
		'struct',
		'typeParameter',
		'type',
		'parameter',
		'variable',
		'property',
		'enumMember',
		'decorator',
		'event',
		'function',
		'method',
		'macro',
		'label',
		'comment',
		'string',
		'keyword',
		'number',
		'regexp',
		'operator',
	],
	tokenModifiers: [
		'declaration',
		'definition',
		'readonly',
		'static',
		'deprecated',
		'abstract',
		'async',
		'modification',
		'documentation',
		'defaultLibrary',
	],
};
