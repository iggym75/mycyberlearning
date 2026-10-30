// My Cyber Learning — Azure resources (all within free tiers or pennies a month).
// Deploy:  az group create -n rg-mycyberlearning -l uksouth
//          az deployment group create -g rg-mycyberlearning -f infra/main.bicep
targetScope = 'resourceGroup'

@description('Short lowercase prefix used in resource names')
param prefix string = 'mycyberlearn'

@description('Region for the storage account (UK South keeps data in the UK)')
param location string = 'uksouth'

@description('Static Web Apps is only offered in some regions; West Europe is the closest to the UK')
param swaLocation string = 'westeurope'

// Table storage for items, votes and submissions. LRS + cool features off = lowest cost.
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${prefix}${uniqueString(resourceGroup().id)}'
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    supportsHttpsTrafficOnly: true
    allowSharedKeyAccess: true
  }
}

resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-site'
  location: swaLocation
  sku: { name: 'Free', tier: 'Free' }
  properties: {
    // Deployment is driven by the GitHub Action using the site's deployment token.
    allowConfigFileUpdates: true
  }
}

// App settings for the managed Functions API.
resource swaSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
    VOTE_SALT: uniqueString(resourceGroup().id, 'vote-salt', storage.id)
    CLAUDE_MODEL: 'claude-haiku-5-5'
    // ANTHROPIC_API_KEY is set separately so it never appears in deployment history:
    // az staticwebapp appsettings set -n <site> --setting-names ANTHROPIC_API_KEY=<key>
  }
}

output siteName string = swa.name
output defaultHostname string = swa.properties.defaultHostname
output storageAccount string = storage.name
