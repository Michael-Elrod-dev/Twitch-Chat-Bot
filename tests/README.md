# AlmostHadAI Test Suite

Comprehensive test suite for the AlmostHadAI Twitch bot using Jest.

## Setup

### Install Dependencies

```bash
npm install
```

This will install Jest and required testing dependencies.

## Running Tests

### Run All Tests
```bash
npm test
```

### Run Tests in Watch Mode
```bash
npm run test:watch
```
Automatically reruns tests when files change. Great for development.

### Run Tests with Coverage Report
```bash
npm run test:coverage
```
Generates a detailed coverage report showing which lines are tested.

### Run Tests with Verbose Output
```bash
npm run test:verbose
```
Shows detailed output for each test case.

### Run Specific Test File
```bash
npm test -- tests/ai/rateLimiter.test.js
```

### Run Tests Matching Pattern
```bash
npm test -- --testNamePattern="session"
```
Runs only tests with "session" in their name.

## Test Structure

```
tests/
├── ai/
│   ├── aiManager.test.js          # AI request handling
│   └── rateLimiter.test.js        # Rate limiting logic
├── analytics/
│   └── viewerTracker.test.js      # Session & analytics tracking
├── commands/
│   └── commandManager.test.js     # Command processing
├── emotes/
│   └── emoteManager.test.js       # Emote CRUD & caching
├── messages/
│   └── chatMessageHandler.test.js # Message routing
└── redemptions/
    └── quotes/
        └── quoteManager.test.js   # Quote management
```

## Test Coverage

Current coverage targets:
- **Branches**: 70%
- **Functions**: 75%
- **Lines**: 75%
- **Statements**: 75%

View detailed coverage report:
```bash
npm run test:coverage
open coverage/index.html
```

## What's Tested

### viewerTracker.test.js
- ✅ User existence management
- ✅ Viewing session lifecycle (start/end/query)
- ✅ Complex session logic (joins/leaves/stays)
- ✅ Chat interaction tracking
- ✅ Chat totals aggregation
- ✅ User statistics queries
- ✅ Top users leaderboard
- ✅ Edge cases and error handling

### rateLimiter.test.js
- ✅ User limit calculation (broadcaster/mod/subscriber/everyone)
- ✅ Rate limit enforcement
- ✅ Usage tracking and updates
- ✅ Per-stream limit isolation
- ✅ Role-based permissions
- ✅ Database error handling
- ✅ Integration scenarios

### aiManager.test.js
- ✅ Initialization and setup
- ✅ Text request handling
- ✅ Rate limit integration
- ✅ Usage counter display
- ✅ Trigger detection (@mentions)
- ✅ Prompt extraction
- ✅ Error responses
- ✅ Full request lifecycle

### commandManager.test.js
- ✅ Command loading and caching
- ✅ Cache refresh logic
- ✅ Command CRUD operations (add/edit/delete)
- ✅ Permission enforcement (everyone/mod/broadcaster)
- ✅ Special handler execution
- ✅ Meta-command (!command) handling
- ✅ Case-insensitive matching
- ✅ Multi-word responses

### chatMessageHandler.test.js
- ✅ Message routing (AI/emotes/commands/regular)
- ✅ Priority order enforcement
- ✅ User context extraction (badges)
- ✅ Bot self-message filtering
- ✅ Channel point redemption filtering
- ✅ Analytics tracking
- ✅ Error handling
- ✅ Response sending

### emoteManager.test.js
- ✅ Emote loading and caching
- ✅ Cache refresh logic
- ✅ Emote CRUD operations (add/edit/delete)
- ✅ Case-insensitive matching
- ✅ Cache expiry handling
- ✅ Duplicate emote handling
- ✅ Error handling
- ✅ Multi-emote cache management

### quoteManager.test.js
- ✅ Quote addition with all fields
- ✅ Quote retrieval by ID
- ✅ Random quote selection
- ✅ Total quote count
- ✅ Empty database handling
- ✅ Integration scenarios
- ✅ Error handling
- ✅ NULL/missing data handling

## Writing New Tests

### Basic Test Structure

```javascript
const YourModule = require('../../src/path/to/module');

describe('YourModule', () => {
    let instance;
    let mockDependency;

    beforeEach(() => {
        mockDependency = {
            method: jest.fn()
        };
        instance = new YourModule(mockDependency);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('yourMethod', () => {
        it('should do something expected', async () => {
            // Arrange
            mockDependency.method.mockResolvedValueOnce('result');

            // Act
            const result = await instance.yourMethod('input');

            // Assert
            expect(result).toBe('expected');
            expect(mockDependency.method).toHaveBeenCalledWith('input');
        });
    });
});
```

### Mocking Database Queries

```javascript
mockDbManager.query.mockResolvedValueOnce([
    { column: 'value' }
]);

// Or for multiple calls
mockDbManager.query
    .mockResolvedValueOnce([{ id: 1 }])  // First call
    .mockResolvedValueOnce([{ id: 2 }])  // Second call
    .mockResolvedValueOnce([]);          // Third call
```

### Testing Async Functions

```javascript
it('should handle async operation', async () => {
    const result = await instance.asyncMethod();
    expect(result).toBeDefined();
});
```

### Testing Error Handling

```javascript
it('should handle errors gracefully', async () => {
    mockDependency.method.mockRejectedValueOnce(new Error('Test Error'));

    await expect(
        instance.methodThatCallsDependency()
    ).resolves.toBeUndefined(); // or .rejects.toThrow()
});
```

## Best Practices

1. **Test Behavior, Not Implementation**
   - Focus on what the code does, not how it does it
   - Test public APIs, not internal details

2. **Use Descriptive Test Names**
   ```javascript
   it('should create session for new viewer')
   it('should not create duplicate sessions for existing viewers')
   ```

3. **Arrange-Act-Assert Pattern**
   ```javascript
   // Arrange - Set up test data and mocks
   mockDb.query.mockResolvedValueOnce([]);

   // Act - Execute the code under test
   const result = await method();

   // Assert - Verify the results
   expect(result).toBe(expected);
   ```

4. **One Assertion Per Test** (when possible)
   - Makes failures easier to diagnose
   - Keeps tests focused and clear

5. **Test Edge Cases**
   - Empty inputs
   - Null/undefined values
   - Boundary conditions
   - Error scenarios

6. **Mock External Dependencies**
   - Database queries
   - API calls
   - File system operations
   - Network requests

## Continuous Improvement

- Add tests when fixing bugs
- Update tests when changing behavior
- Maintain coverage above thresholds
- Review test failures carefully
- Keep tests fast and independent

## Troubleshooting

### Tests Timeout
Increase timeout in jest.config.js:
```javascript
testTimeout: 20000 // 20 seconds
```

### Mocks Not Clearing
Ensure `afterEach()` calls `jest.clearAllMocks()`

### Coverage Not Accurate
Delete coverage folder and run again:
```bash
rm -rf coverage
npm run test:coverage
```

### Tests Fail Locally But Pass in CI
- Check for timing issues
- Ensure mocks are properly reset
- Verify no test interdependencies
