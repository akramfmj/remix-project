'use strict'
import { CompilerAbstract } from '@remix-project/remix-solidity'
import { Compiler } from '@remix-project/remix-solidity'

import { CompilationResult, CompilationSource } from '@remix-project/remix-solidity'
import { CodeParser } from "../code-parser";
import { fileDecoration, fileDecorationType } from '@remix-ui/file-decorators'
import { sourceMappingDecoder } from '@remix-project/remix-debug'
import { CompilerRetriggerMode } from '@remix-project/remix-solidity-ts';
import { MarkerSeverity } from 'monaco-editor';

type errorMarker = {
    message: string
    severity: MarkerSeverity
    position: {
      start: {
        line: number
        column: number
      },
      end: {
        line: number
        column: number
      }
    },
    file: string
  }
export default class CodeParserCompiler {
    plugin: CodeParser
    compiler: any // used to compile the current file seperately from the main compiler
    onAstFinished: (success: any, data: CompilationResult, source: CompilationSource, input: any, version: any) => Promise<void>;
    errorState: boolean;
    gastEstimateTimeOut: any
    constructor(
        plugin: CodeParser
    ) {
        this.plugin = plugin
    }

    init() {

        this.onAstFinished = async (success, data: CompilationResult, source: CompilationSource, input: any, version) => {
            this.plugin.call('editor', 'clearAnnotations')
            this.errorState = true
            const result = new CompilerAbstract('soljson', data, source, input)
            let allErrors: errorMarker[] = []
            if (data.errors) {
                const sources = result.getSourceCode().sources
                for (const error of data.errors) {

                    const lineBreaks = sourceMappingDecoder.getLinebreakPositions(sources[error.sourceLocation.file].content)
                    const lineColumn = sourceMappingDecoder.convertOffsetToLineColumn({
                        start: error.sourceLocation.start,
                        length: error.sourceLocation.end - error.sourceLocation.start
                    }, lineBreaks)

                    const filePath = error.sourceLocation.file

                    allErrors = [...allErrors, {
                        message: error.formattedMessage,
                        severity: error.severity === 'error' ? MarkerSeverity.Error : MarkerSeverity.Warning,
                        position: {
                            start: {
                                line: ((lineColumn.start && lineColumn.start.line) || 0) + 1,
                                column: ((lineColumn.start && lineColumn.start.column) || 0) + 1
                            },
                            end: {
                                line: ((lineColumn.end && lineColumn.end.line) || 0) + 1,
                                column: ((lineColumn.end && lineColumn.end.column) || 0) + 1
                            }
                        }
                        , file: filePath
                     }]
                }
                const displayErrors = await this.plugin.call('config', 'getAppParameter', 'display-errors')
                if(displayErrors) await this.plugin.call('editor', 'addErrorMarker', allErrors)
                this.addDecorators(allErrors, sources)
            } else {
                await this.plugin.call('editor', 'clearErrorMarkers', result.getSourceCode().sources)
                await this.clearDecorators(result.getSourceCode().sources)
            }


            if (!data.sources) return
            if (data.sources && Object.keys(data.sources).length === 0) return
            this.plugin.compilerAbstract = new CompilerAbstract('soljson', data, source, input)
            this.errorState = false
            this.plugin.nodeIndex = {
                declarations: {},
                flatReferences: {},
                nodesPerFile: {},
            }


            this.plugin._buildIndex(data, source)
            this.plugin.nodeIndex.nodesPerFile[this.plugin.currentFile] = this.plugin._extractFileNodes(this.plugin.currentFile, this.plugin.compilerAbstract)
            await this.plugin.gasService.showGasEstimates()
            this.plugin.emit('astFinished')
        }

        this.compiler = new Compiler((url, cb) => this.plugin.call('contentImport', 'resolveAndSave', url, undefined).then((result) => cb(null, result)).catch((error) => cb(error.message)))
        this.compiler.event.register('compilationFinished', this.onAstFinished)
    }

    // COMPILER

    /**
     * 
     * @returns 
     */
    async compile() {
        try {
            this.plugin.currentFile = await this.plugin.call('fileManager', 'file')
            if (this.plugin.currentFile && this.plugin.currentFile.endsWith('.sol')) {
                const state = await this.plugin.call('solidity', 'getCompilerState')
                this.compiler.set('optimize', state.optimize)
                this.compiler.set('evmVersion', state.evmVersion)
                this.compiler.set('language', state.language)
                this.compiler.set('runs', state.runs)
                this.compiler.set('useFileConfiguration', true)
                this.compiler.set('compilerRetriggerMode', CompilerRetriggerMode.retrigger)
                const configFileContent = {
                    "language": "Solidity",
                    "settings": {
                        "optimizer": {
                            "enabled": false,
                            "runs": 200
                        },
                        "outputSelection": {
                            "*": {
                                "": ["ast"],
                                "*": ["evm.gasEstimates"]
                            }
                        },
                        "evmVersion": state.evmVersion && state.evmVersion.toString() || "byzantium",
                    }
                }

                this.compiler.set('configFileContent', JSON.stringify(configFileContent))
                this.plugin.currentFile = await this.plugin.call('fileManager', 'file')
                if (!this.plugin.currentFile) return
                const content = await this.plugin.call('fileManager', 'readFile', this.plugin.currentFile)
                const sources = { [this.plugin.currentFile]: { content } }
                this.compiler.compile(sources, this.plugin.currentFile)
            }
        } catch (e) {
           // do nothing
        }
    }

    async addDecorators(allErrors: errorMarker[], sources: any) {
        const displayErrors = await this.plugin.call('config', 'getAppParameter', 'display-errors')
        if(!displayErrors) return
        const errorsPerFiles: {[fileName: string]: errorMarker[]} = {}
        for (const error of allErrors) {
            if (!errorsPerFiles[error.file]) {
                errorsPerFiles[error.file] = []
            }
            errorsPerFiles[error.file].push(error)
        }

        const errorPriority = {
            'error': 0,
            'warning': 1,
        }

        // sort errorPerFiles by error priority
        const sortedErrorsPerFiles: {[fileName: string]: errorMarker[]} = {}
        for (const fileName in errorsPerFiles) {
            const errors = errorsPerFiles[fileName]
            errors.sort((a, b) => {
                return errorPriority[a.severity] - errorPriority[b.severity]
            }
            )
            sortedErrorsPerFiles[fileName] = errors
        }
        const filesWithOutErrors = Object.keys(sources).filter((fileName) => !sortedErrorsPerFiles[fileName])
        // add decorators
        const decorators: fileDecoration[] = []
        for (const fileName in sortedErrorsPerFiles) {
            const errors = sortedErrorsPerFiles[fileName]
            const decorator: fileDecoration = {
                path: fileName,
                isDirectory: false,
                fileStateType: errors[0].severity == MarkerSeverity.Error? fileDecorationType.Error : fileDecorationType.Warning,
                fileStateLabelClass: errors[0].severity == MarkerSeverity.Error ? 'text-danger' : 'text-warning',
                fileStateIconClass: '',
                fileStateIcon: '',
                text: errors.length.toString(),
                owner: 'code-parser',
                bubble: true,
                comment: errors.map((error) => error.message),
            }
            decorators.push(decorator)
        }
        for (const fileName of filesWithOutErrors) {
            const decorator: fileDecoration = {
                path: fileName,
                isDirectory: false,
                fileStateType: fileDecorationType.None,
                fileStateLabelClass: '',
                fileStateIconClass: '',
                fileStateIcon: '',
                text: '',
                owner: 'code-parser',
                bubble: false
            }
            decorators.push(decorator)
        }
        await this.plugin.call('fileDecorator', 'setFileDecorators', decorators)
        await this.plugin.call('editor', 'clearErrorMarkers', filesWithOutErrors)

    }

    async clearDecorators(sources: any) {
        const decorators: fileDecoration[] = []
        for (const fileName of Object.keys(sources)) {
            const decorator: fileDecoration = {
                path: fileName,
                isDirectory: false,
                fileStateType: fileDecorationType.None,
                fileStateLabelClass: '',
                fileStateIconClass: '',
                fileStateIcon: '',
                text: '',
                owner: 'code-parser',
                bubble: false
            }
            decorators.push(decorator)
        }


        await this.plugin.call('fileDecorator', 'setFileDecorators', decorators)
    }

}