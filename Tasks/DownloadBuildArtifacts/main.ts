var path = require('path')
var url = require('url')

import * as tl from 'vsts-task-lib/task';
import { WebApi, getHandlerFromToken } from 'vso-node-api/WebApi';

import * as models from "item-level-downloader/Models"
import * as engine from "item-level-downloader/Engine"
import * as providers from "item-level-downloader/Providers"
import * as webHandlers from "item-level-downloader/Providers/Handlers"

tl.setResourcePath(path.join(__dirname, 'task.json'));

async function main(): Promise<void> {
    var promise = new Promise<void>(async (resolve, reject) => {
        var projectId = tl.getInput("project", false);
        var definitionId = tl.getInput("definition", false);
        var buildId = parseInt(tl.getInput("buildId", true));
        var downloadPath = tl.getInput("downloadPath", true);
        var downloadType = tl.getInput("downloadType", true);

        var endpointUrl = tl.getEndpointUrl('SYSTEMVSSCONNECTION', false);
        var accessToken = tl.getEndpointAuthorizationParameter('SYSTEMVSSCONNECTION', 'AccessToken', false);
        var credentialHandler = getHandlerFromToken(accessToken);
        var vssConnection = new WebApi(endpointUrl, credentialHandler);
        var debugMode = tl.getVariable('System.Debug');
        var verbose = debugMode ? debugMode.toLowerCase() != 'false' : false;

        var templatePath = path.join(__dirname, 'vsts.handlebars.txt');
        var buildApi = vssConnection.getBuildApi();
        var artifacts = [];
        var itemPattern = '**';

        // verfiy that buildId belongs to the definition selected
        if (definitionId) {
            var builds = await buildApi.getBuilds(projectId, [parseInt(definitionId)]).catch((reason) => {
                reject(reason);
            });

            if (builds) {
                var buildIds = builds.map((value, index) => {
                    return value.id;
                });

                if (buildIds.indexOf(buildId) == -1) {
                    reject(tl.loc("BuildIdBuildDefinitionMismatch", buildId, definitionId));
                }
            }
            else {
                reject(tl.loc("NoBuildsFound", definitionId));
            }
        }

        // populate itempattern and artifacts based on downloadType
        if (downloadType === 'single') {
            var artifactName = tl.getInput("artifactName");
            var artifact = await buildApi.getArtifact(buildId, artifactName, projectId).catch((reason) => {
                reject(reason);
            });
            artifacts.push(artifact);
            itemPattern = artifactName + '/**';
        }
        else {
            var buildArtifacts = await buildApi.getArtifacts(buildId, projectId).catch((reason) => {
                reject(reason);
            });

            console.log(tl.loc("LinkedArtifactCount", buildArtifacts.length));
            artifacts = artifacts.concat(buildArtifacts);
            itemPattern = tl.getInput("itemPattern", false) || '**';
        }

        var downloadPromises: Array<Promise<void>> = [];

        artifacts.forEach(async function (artifact, index, artifacts) {
            if (artifact.resource.type.toLowerCase() === "container") {
                let downloader = new engine.ArtifactEngine();
                var downloaderOptions = new engine.ArtifactEngineOptions();
                downloaderOptions.itemPattern = itemPattern;
                downloaderOptions.parallelProcessingLimit = +tl.getVariable("release.artifact.download.parallellimit") || 8;
                downloaderOptions.verbose = verbose;

                var containerParts: string[] = artifact.resource.data.split('/', 3);
                if (containerParts.length !== 3) {
                    throw new Error(tl.loc("FileContainerInvalidArtifactData"));
                }

                var containerId: number = parseInt(containerParts[1]);
                var containerPath: string = containerParts[2];

                var itemsUrl = endpointUrl + "/_apis/resources/Containers/" + containerId + "?itemPath=" + containerPath + "&isShallow=true";
                console.log(tl.loc("DownloadArtifacts", itemsUrl));

                var variables = {};
                var handler = new webHandlers.PersonalAccessTokenCredentialHandler(accessToken);
                var webProvider = new providers.WebProvider(itemsUrl, templatePath, variables, handler);
                var fileSystemProvider = new providers.FilesystemProvider(downloadPath);

                downloadPromises.push(downloader.processItems(webProvider, fileSystemProvider, downloaderOptions).catch((reason) => {
                    reject(reason);
                }));
            }
            else if (artifact.resource.type.toLowerCase() === "filepath") {
                let downloader = new engine.ArtifactEngine();
                var downloaderOptions = new engine.ArtifactEngineOptions();
                downloaderOptions.itemPattern = itemPattern;
                downloaderOptions.parallelProcessingLimit = +tl.getVariable("release.artifact.download.parallellimit") || 8;
                downloaderOptions.verbose = verbose;

                console.log(tl.loc("DownloadArtifacts", artifact.resource.downloadUrl));
                var fileShareProvider = new providers.FilesystemProvider(artifact.resource.downloadUrl.replace("file:", ""));
                var fileSystemProvider = new providers.FilesystemProvider(downloadPath);

                downloadPromises.push(downloader.processItems(fileShareProvider, fileSystemProvider, downloaderOptions).catch((reason) => {
                    reject(reason);
                }));
            }
            else {
                tl.warning(tl.loc("UnsupportedArtifactType", artifact.resource.type));
            }
        });

        Promise.all(downloadPromises).then(() => {
            resolve();
        }).catch((error) => {
            reject(error);
        });
    });

    return promise;
}

main()
    .then((result) => tl.setResult(tl.TaskResult.Succeeded, ""))
    .catch((error) => tl.setResult(tl.TaskResult.Failed, error));