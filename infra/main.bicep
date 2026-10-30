// My Cyber Learning: Azure resources (free tiers or pennies a month).
//
// First deployment (email domain not yet verified):
//   az group create -n rg-mycyberlearning -l uksouth
//   az deployment group create -g rg-mycyberlearning -f infra/main.bicep \
//     -p tokenSecret="<saved value>" voteSalt="<saved value>" anthropicApiKey="<key>"
// Generate each secret once with `openssl rand -hex 32` and keep it in a password manager: every redeploy
// must pass the same values, and the GitHub secret TOKEN_SECRET must equal tokenSecret exactly.
// Then add the DNS records shown in the Azure portal for the email domain (SPF, DKIM x2, domain TXT),
// verify it, and redeploy with  -p linkEmailDomain=true  (and the same secrets) to enable sending.
targetScope = 'resourceGroup'

@description('Short lowercase prefix used in resource names')
param prefix string = 'mycyberlearn'

@description('Region for storage (UK South keeps data in the UK)')
param location string = 'uksouth'

@description('Static Web Apps is only offered in some regions; West Europe is the closest to the UK')
param swaLocation string = 'westeurope'

@description('Public site URL used in emails and redirects')
param siteUrl string = 'https://mycyberlearning.co.uk'

@description('Domain the briefing is sent from. Must be one you control; you add its DNS records.')
param mailDomain string = 'mycyberlearning.co.uk'

@description('Sender mailbox name, e.g. briefing -> briefing@mycyberlearning.co.uk')
param mailUser string = 'briefing'

@description('Set true only after the email domain shows as Verified in the portal')
param linkEmailDomain bool = false

@secure()
@minLength(32)
@description('Random secret for signing unsubscribe links and deriving subscriber ids. Generate with: openssl rand -hex 32')
param tokenSecret string

@secure()
@minLength(32)
@description('Random salt for hashing voter ids. Generate with: openssl rand -hex 32')
param voteSalt string

@secure()
@description('Anthropic API key for tagging suggestions (optional). Passed here because redeploying replaces all app settings.')
param anthropicApiKey string = ''

// ---------- Storage (Table storage for items, votes, submissions, subscribers, stats) ----------
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('${prefix}${uniqueString(resourceGroup().id)}', 24)   // storage names: 3-24 lowercase letters/digits
  location: location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
    allowSharedKeyAccess: true          // the Static Web Apps managed API can't use managed identity; keys live only in app settings / GitHub secrets
    defaultToOAuthAuthentication: true  // portal and tooling use Entra ID by default
    encryption: {
      keySource: 'Microsoft.Storage'
      requireInfrastructureEncryption: true   // double encryption at rest
      services: { table: { enabled: true, keyType: 'Account' }, blob: { enabled: true } }
    }
  }
}

// ---------- Email (Azure Communication Services) ----------
resource emailService 'Microsoft.Communication/emailServices@2023-04-01' = {
  name: '${prefix}-email'
  location: 'global'
  properties: { dataLocation: 'UK' }
}

resource emailDomain 'Microsoft.Communication/emailServices/domains@2023-04-01' = {
  parent: emailService
  name: mailDomain
  location: 'global'
  properties: {
    domainManagement: 'CustomerManaged'
    userEngagementTracking: 'Disabled'   // no open/click tracking
  }
}

resource sender 'Microsoft.Communication/emailServices/domains/senderUsernames@2023-04-01' = {
  parent: emailDomain
  name: mailUser
  properties: { username: mailUser, displayName: 'My Cyber Learning' }
}

resource acs 'Microsoft.Communication/communicationServices@2023-04-01' = {
  name: '${prefix}-acs'
  location: 'global'
  properties: {
    dataLocation: 'UK'
    linkedDomains: linkEmailDomain ? [ emailDomain.id ] : []
  }
}

// ---------- Site + managed API ----------
resource swa 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-site'
  location: swaLocation
  sku: { name: 'Free', tier: 'Free' }
  properties: { allowConfigFileUpdates: true }
}

resource swaSettings 'Microsoft.Web/staticSites/config@2023-12-01' = {
  parent: swa
  name: 'appsettings'
  properties: {
    STORAGE_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=${storage.name};AccountKey=${storage.listKeys().keys[0].value};EndpointSuffix=${environment().suffixes.storage}'
    ACS_CONNECTION_STRING: acs.listKeys().primaryConnectionString
    MAIL_FROM: '${mailUser}@${mailDomain}'
    SITE_URL: siteUrl
    TOKEN_SECRET: tokenSecret
    VOTE_SALT: voteSalt
    CLAUDE_MODEL: 'claude-haiku-5-5'
    // Every redeploy replaces the whole settings set, so all settings (including secrets) are declared here.
    ANTHROPIC_API_KEY: anthropicApiKey
  }
}

output siteName string = swa.name
output defaultHostname string = swa.properties.defaultHostname
output storageAccount string = storage.name
output communicationService string = acs.name
output emailDomainResource string = emailDomain.name
output mailFrom string = '${mailUser}@${mailDomain}'
