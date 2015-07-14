'use strict';

var github = require('octonode');
var Q = require('q');

var commenter = require('./commenter');
var diff = require('./diffParse');
var logger = require('./logger');
var processor = require('./processor');
var utils = require('./utils');
var config = require('./config');

var configFilename = '.doiuse';
var githubClient = github.client(config.token);

/**
 * Handle requests to /hook.
 */
function handle(request, response) {
    var eventType = request.headers['x-github-event'];
    var metadata = request.body;
    var pr = metadata.pull_request;
    var originRepo = pr.head.repo.full_name;

    response.status(200).send('OK');

    // React to pull requests only
    if (eventType === 'pull_request') {
        logger.log('Compatibility test requested from:', originRepo);

        processPullRequest(
            metadata.repository.full_name,
            originRepo,
            pr.head.ref,
            metadata.number,
            pr.review_comments_url
        );
    }
    else {
        logger.info('Invalid event type (', eventType, ') requested by:', originRepo);
    }
}

/**
 * React to a new pull request. Go through all changes to stylesheets, test
 * those changes, and report any incompatibilities.
 */
function processPullRequest(destinationRepo, originRepo, originBranch, prNumber, commentURL) {
    var commits = getPullRequestCommits(destinationRepo, prNumber);
    var config = getConfig(originRepo, originBranch);

    // Once we have pulled down commit metadata and doiuse configuration...
    Q.all([commits, config]).spread(function(commits, config) {

        // Go through each commit...
        commits.forEach(function(currentCommit) {

            // And each file of each commit... and report on the changes.
            currentCommit.files.forEach(function(file) {

                processor.process(githubClient, originRepo, originBranch, file, config, function(incompatibility) {
                    // Callback for handling an incompatible line of code
                    var line = diff.lineToIndex(file.patch, incompatibility.usage.source.start.line);
                    var comment = incompatibility.featureData.title + ' not supported by: ' + incompatibility.featureData.missing;
                    commenter.postPullRequestComment(commentURL, comment, file.filename, currentCommit.sha, line);
                });

            });

        });
    }).catch(logger.error);
}

/**
 * Get the doiuse configuration of a repository at a particular branch.
 */
function getConfig(repo, branch) {
    var deferred = Q.defer();

    githubClient.repo(repo).contents(configFilename, branch, function(error, configFileMetadata) {
        var config = ['last 2 versions']; // Default configuration

        // Only replace the default config if the .doiuse file exists and has content
        if (!error && configFileMetadata.content) {
            // Consider text separated by commas and linebreaks to be individual options
            config = utils.prepareContent(configFileMetadata.content).replace(/\r?\n|\r/g, ', ').split(/,\s*/);
        }

        deferred.resolve(config);
    });

    return deferred.promise;
}

/**
 * Get an array of detailed metadata about the commits of a given pull request.
 * Metadata format: https://developer.github.com/v3/repos/commits/#get-a-single-commit
 */
function getPullRequestCommits(repo, number) {
    var deferred = Q.defer();

    githubClient.pr(repo, number).commits(function(error, commits) {
        var promises = [];

        if (error) return deferred.reject('Error fetching commits from pull request ' + number + ' of ' + repo + ':', error);

        // Build an array of commit detail promises
        commits.forEach(function(currentCommit) {
            promises.push(getCommitDetail(repo, currentCommit.sha));
        });

        // When all of the commit detail promises have been resolved,
        // resolve an array of commit detail
        Q.all(promises).spread(function() {
            deferred.resolve(Array.prototype.slice.call(arguments));
        });

    });

    return deferred.promise;
}

/**
 * Get detailed metadata about a single commit.
 * Metadata format: https://developer.github.com/v3/repos/commits/#get-a-single-commit
 */
function getCommitDetail(repo, sha) {
    var deferred = Q.defer();
    var repoClient = githubClient.repo(repo);

    repoClient.commit(sha, function(error, commitDetail) {
        if (error) {
            deferred.reject('Error fetching detail of commit ' + sha + ' from ' + repo + ':', error);
        } else {
            deferred.resolve(commitDetail);
        }
    });

    return deferred.promise;
}

exports.handle = handle;
