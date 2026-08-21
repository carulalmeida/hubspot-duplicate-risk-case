# hubspot-duplicate-risk-case
Technical case - HubSpot contact deduplication by phone

Solução desenvolvida para identificar possíveis contatos duplicados no HubSpot a partir da normalização e comparação do campo `phone`.

O objetivo do script é lidar com situações em que o mesmo telefone pode estar cadastrado em formatos diferentes e preencher automaticamente a propriedade:

```text
duplicate_risk
```

com:

```text
true
false
```

A solução foi desenvolvida para um desafio técnico e prioriza clareza da lógica, cobertura dos cenários de teste e facilidade de manutenção. Não foi projetada como uma solução `production-ready`.

---

## Estrutura do repositório

```text
hubspot-duplicate-risk-case/
│
├── src/
│   └── duplicate-risk.js
│
├── tests/
│   └── base-unificada-cenarios-teste.xlsx
│
└── README.md
```

### `src`

Contém o código JavaScript utilizado na `Custom Code Action` do HubSpot.

### `tests`

Contém a massa utilizada para validar os diferentes cenários de normalização e identificação de duplicidade.

---

# Como a solução funciona

O script executa sete etapas principais:

1. busca os contatos no HubSpot;
2. limpa e classifica os telefones;
3. normaliza números internacionais e locais;
4. agrupa contatos pelo telefone normalizado;
5. identifica os grupos duplicados;
6. prepara apenas os contatos cujo `duplicate_risk` precisa mudar;
7. atualiza os contatos no HubSpot em `batch`.

---

## 1. Busca dos contatos

A função:

```javascript
getAllContacts()
```

busca todos os contatos não arquivados do HubSpot utilizando paginação.

São consultadas as propriedades:

```text
phone
duplicate_risk
```

A paginação é necessária porque a API retorna uma quantidade limitada de contatos por requisição.

---

## 2. Limpeza do telefone

A função:

```javascript
cleanPhone()
```

é responsável apenas por preparar o valor antes da classificação.

Ela:

* remove espaços externos;
* remove caracteres de formatação;
* remove ramais no final do telefone;
* mantém somente os dígitos;
* identifica se o valor original começava com `+`.

Por exemplo:

```text
+55 (11) 99999-0001
```

é convertido para:

```text
5511999990001
```

Ramais como:

```text
ramal 123
ext. 45
extension 123
x99
```

também são removidos antes da comparação.

---

## 3. Classificação dos telefones

A função:

```javascript
classifyPhone()
```

classifica cada telefone como:

```text
international
```

ou:

```text
local
```

Além disso, o resultado recebe um nível de `confidence`.

### Internacional explícito

Números iniciados por `+` ou `00` são considerados explicitamente internacionais.

Exemplos:

```text
+44 20 7946 0958
00442079460958
```

Resultado:

```text
type: international
confidence: high
```

No caso de `00`, o prefixo é removido:

```text
00442079460958
↓
442079460958
```

---

### Internacional inferido

Um telefone entre 12 e 15 dígitos, sem `+` ou `00` e sem começar por `0`, é considerado um possível número internacional.

Exemplo:

```text
5511999999999
```

Resultado:

```text
type: international
confidence: inferred
```

A classificação é considerada inferida porque o número não possui um prefixo internacional explícito.

---

### Telefone local

Os demais telefones válidos são classificados como locais.

O script também considera a possibilidade de um `trunk prefix`.

Por exemplo:

```text
02079460958
```

pode ser tratado como:

```text
2079460958
```

O `0` inicial é removido antes da tentativa de correlação.

Essa é uma heurística da solução atual. Em uma implementação mais robusta, esse comportamento deveria considerar as regras específicas do país.

---

# Constantes de classificação

Os limites utilizados na classificação foram extraídos para constantes, evitando valores numéricos espalhados pelo código.

```javascript
MIN_INTL_DIGITS
MAX_INTL_DIGITS
MIN_INFERRED_INTL_DIGITS
MIN_TRUNK_ZERO_STRIP_LENGTH
MIN_LOCAL_DIGITS
MIN_LOCAL_SUFFIX_MATCH_LENGTH
```

Isso torna as regras mais explícitas e facilita futuras alterações.

Por exemplo:

```javascript
const MIN_LOCAL_SUFFIX_MATCH_LENGTH = 10;
```

deixa claro que um telefone local precisa ter pelo menos 10 dígitos para participar da correlação por sufixo com um telefone internacional.

---

# Redução de falsos positivos

Um dos principais refinamentos realizados durante os testes foi separar:

```text
telefone local válido
```

de:

```text
telefone com informação suficiente para correlação internacional
```

Um telefone com 8 ou 9 dígitos pode ser válido localmente, mas possui pouco contexto para ser comparado com números internacionais.

Por exemplo:

```text
12345678
```

poderia aparecer como sufixo de vários números:

```text
+49 30 12345678
+81 3 1234 5678
```

Por isso, a versão final estabelece que telefones locais com menos de 10 dígitos:

* continuam válidos para comparação local;
* podem ser duplicados de outro telefone local igual;
* não participam da correlação por sufixo com números internacionais.

Assim:

```text
12345678
12345678
```

podem formar um grupo duplicado.

Por outro lado:

```text
12345678
+81 3 1234 5678
```

não são considerados automaticamente o mesmo telefone.

---

# Correlação entre telefone local e internacional

Para telefones locais com pelo menos 10 dígitos, o script tenta encontrar um telefone internacional correspondente.

Exemplo:

```text
Local:
2079460958
```

e:

```text
Internacional:
442079460958
```

O número internacional termina em:

```text
2079460958
```

Atualmente essa comparação é feita com:

```javascript
international.endsWith(parsed.value)
```

A associação só acontece quando existe **exatamente um candidato internacional**.

### Um candidato

```text
2079460958
↓
442079460958
```

Os contatos recebem a mesma chave normalizada.

### Nenhum candidato

O telefone continua local:

```text
LOCAL:2079460958
```

### Mais de um candidato

A solução considera o resultado ambíguo e também mantém o número local:

```text
LOCAL:2079460958
```

Dessa forma, o script evita escolher arbitrariamente um número internacional quando não há informação suficiente.

---

# Agrupamento dos contatos

Depois da normalização, o script utiliza um `Map` para agrupar contatos pelo valor de:

```text
normalizedPhone
```

Exemplo:

```text
442079460958
├── Contato A
├── Contato B
└── Contato C
```

Quando o grupo possui mais de um contato, todos os IDs são adicionados ao conjunto:

```javascript
duplicateIds
```

Então:

```text
duplicate_risk = true
```

é utilizado para contatos que pertencem a um grupo com mais de um registro.

Os demais recebem:

```text
duplicate_risk = false
```

---

# Atualização do HubSpot

Antes de atualizar um contato, o script compara o valor calculado com o valor que já está armazenado no HubSpot.

Se o valor atual já estiver correto, nenhuma atualização é realizada.

Isso evita chamadas desnecessárias à API.

As atualizações necessárias são enviadas em lotes por meio da função:

```javascript
batchUpdateContacts()
```

com até:

```text
100 contatos por batch
```

---

# Atualização de contatos já existentes

Um comportamento importante validado durante os testes foi a atualização retroativa.

Quando um novo contato é criado com um telefone que já existe, não apenas o novo contato precisa receber:

```text
duplicate_risk = true
```

O contato antigo também precisa ser atualizado.

Isso ocorre porque o script recalcula os grupos considerando todos os contatos disponíveis.

Dois casos foram observados durante os testes.

### Caso França

Contato existente do teste de 18/08:

```text
Claire Martin
+33 1 42 68 53 00
```

Posteriormente, no teste de 19/08, foi criado:

```text
CT025
+33 1 42 68 53 00
```

O resultado foi:

```text
Claire Martin → duplicate_risk = true
CT025         → duplicate_risk = true
```

O histórico do contato no HubSpot permitiu validar a alteração do registro que já existia.

---

### Caso Japão

Contato existente do teste de 18/08:

```text
Haruto Sato
+81 3 1234 5678
```

No teste seguinte foi criado:

```text
CT065
+81 3 1234 5678
```

O resultado foi:

```text
Haruto Sato → duplicate_risk = true
CT065       → duplicate_risk = true
```

Novamente, o histórico do HubSpot confirmou que o contato anterior foi atualizado após a entrada do novo registro.

---

# Estratégia de testes

Os testes foram realizados em duas rodadas.

## Testes de 18/08

Primeira massa:

```text
18 contatos
```

Foram avaliados cenários como:

* telefone local versus internacional;
* números internacionais;
* telefone com prefixo `00`;
* contatos sem país;
* contatos sem telefone;
* telefones únicos;
* grupos com múltiplos duplicados.

---

## Testes de 19/08

Na segunda rodada foram adicionados:

```text
66 novos contatos
```

Os 18 contatos do teste anterior permaneceram no HubSpot.

Portanto, a execução final considerou:

```text
84 contatos
```

Essa situação também permitiu testar como os novos registros impactavam contatos já existentes.

A massa de 19/08 incluiu casos como:

* internacional explícito com `+`;
* internacional iniciado por `00`;
* internacional inferido;
* diferentes máscaras;
* espaços e hífens;
* ramais;
* `trunk prefix`;
* números inválidos;
* limites mínimos e máximos;
* telefone local curto;
* ambiguidade entre diferentes números internacionais;
* duplicidade entre números locais;
* correlação entre local e internacional.

---

# Resultado final dos testes

Na validação final:

```text
84 contatos analisados
25 grupos duplicados
63 contatos com duplicate_risk = true
21 contatos com duplicate_risk = false
```

Os resultados encontrados ficaram de acordo com o comportamento esperado para os cenários testados.

```text
84 / 84 contatos validados
```

A planilha completa utilizada na validação está disponível na pasta:

```text
tests/
```

Ela também identifica quais contatos pertenciam à massa de 18/08 e quais foram criados em 19/08, permitindo visualizar os grupos que cruzaram as duas rodadas de teste.

---

# Refatorações realizadas

Além da lógica funcional, algumas melhorias foram feitas na estrutura do código.

## Centralização da validação internacional

A lógica repetida de validação de números internacionais foi centralizada na função:

```javascript
toInternationalResult()
```

Antes, as mesmas verificações de tamanho precisariam existir em diferentes pontos da classificação.

Agora existe uma única função responsável por validar e montar o resultado internacional.

Isso reduz duplicação e facilita manutenção.

---

## Remoção de números mágicos

Valores utilizados nas regras de telefone foram transformados em constantes.

Por exemplo:

```javascript
const MIN_INTL_DIGITS = 8;
const MAX_INTL_DIGITS = 15;
const MIN_INFERRED_INTL_DIGITS = 12;
const MIN_TRUNK_ZERO_STRIP_LENGTH = 9;
const MIN_LOCAL_DIGITS = 8;
const MIN_LOCAL_SUFFIX_MATCH_LENGTH = 10;
```

Com isso, as regras ficam documentadas no próprio código e podem ser alteradas em um único ponto.

---

## Tratamento de erros

O tratamento de erros também foi refinado.

Erros transitórios:

```text
429
5xx
```

são preservados para permitir `retry`.

Para os demais casos, é gerada uma mensagem mais curta com informações relevantes da resposta da API.

Além disso, o erro original é preservado utilizando:

```javascript
{ cause: error }
```

facilitando a investigação da causa raiz.

---

# Limitações e melhorias para produção

A solução atual atende ao objetivo do desafio técnico, mas alguns pontos foram identificados para uma possível evolução.

## Normalização considerando país

A versão atual utiliza heurísticas gerais para interpretar os telefones.

Em uma solução de produção, seria recomendado utilizar informações como:

```text
country
country code
DDD / DDI
```

quando disponíveis.

Isso permitiria aplicar regras específicas de cada plano de numeração.

Também reduziria falsos positivos e diminuiria o universo de números comparados.

Conceitualmente:

```text
telefone local
        ↓
identifica país
        ↓
aplica regra do país
        ↓
normalização
```

---

## Índice de sufixos

Atualmente, para cada telefone local elegível, o script percorre os números internacionais procurando correspondência por:

```javascript
endsWith()
```

Em uma base maior, essa estratégia aumenta a quantidade de comparações.

Uma evolução seria construir previamente um índice de sufixos.

Por exemplo:

```text
2079460958
→
442079460958
```

Assim, em vez de percorrer todos os internacionais para cada telefone local, seria possível consultar diretamente os candidatos daquele sufixo.

Isso reduziria significativamente o custo da comparação.

---

## Substituição do `full scan`

O principal risco arquitetural da implementação atual é o:

```text
full scan
```

A cada execução, o código busca todos os contatos do HubSpot.

Essa abordagem foi útil para o desafio porque garantiu um comportamento importante:

```text
novo duplicado entra
        ↓
grupo é recalculado
        ↓
contato novo é atualizado
        ↓
contato antigo também é atualizado
```

Porém, em uma base grande, executar esse processo para cada alteração de contato pode gerar:

* muitas chamadas à API;
* aumento no tempo de execução;
* consumo desnecessário de memória;
* processamento repetido;
* risco de concorrência entre execuções.

Uma evolução seria utilizar processamento incremental.

```text
Telefone criado ou alterado
        ↓
Normaliza o telefone
        ↓
Localiza possíveis contatos relacionados
        ↓
Recalcula somente o grupo afetado
        ↓
Atualiza os registros necessários
```

Dessa forma, seria possível preservar a atualização dos contatos antigos sem precisar recalcular toda a base a cada execução.

---

# Tecnologias utilizadas

```text
Node.js
Axios
HubSpot CRM API
HubSpot Custom Code Action
```

Dependência utilizada:

```javascript
const axios = require('axios');
```

Secret necessário:

```text
HUBSPOT_ACCESS_TOKEN
```

Propriedade utilizada para armazenar o resultado:

```text
duplicate_risk
```

---

# Conclusão

A solução foi construída priorizando uma lógica de deduplicação compreensível e testável.

A versão final contempla:

* limpeza dos telefones;
* remoção de ramais;
* identificação de números internacionais explícitos;
* inferência controlada de números internacionais;
* tratamento de números locais;
* tratamento de `trunk prefix`;
* diferentes níveis de `confidence`;
* proteção para telefones locais curtos;
* tratamento de cenários ambíguos;
* agrupamento por telefone normalizado;
* atualização apenas quando necessária;
* atualização em `batch`;
* atualização retroativa de contatos que passam a fazer parte de um grupo duplicado;
* tratamento de erros da API.

Os testes também permitiram identificar os principais pontos de evolução necessários para uma implementação em maior escala, principalmente normalização por país, índice de sufixos e substituição do `full scan` por um processamento incremental.
