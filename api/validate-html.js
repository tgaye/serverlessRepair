#!/usr/bin/env node
/**
 * p5-repair.js — Fixes unbalanced parentheses and other syntax issues in P5.js <script> blocks 
 * using acorn-loose for detection and deepseek-chat for intelligent fixes
 */
const fs = require('fs');
const path = require('path');
const acornLoose = require('acorn-loose');
const axios = require('axios');
const puppeteer = require('puppeteer');

// Placeholder API key - replace with your actual key
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
const DEEPSEEK_API_URL = "https://quiddit.ai/api/deepseek/chat/completions";

// At the very top, add error handling
export default async function handler(req, res) {
    console.log('Function called with method:', req.method);
    console.log('Headers:', req.headers);
    
    // Set CORS headers FIRST - before any other logic
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      console.log('Handling OPTIONS preflight request');
      return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
      console.log('Invalid method:', req.method);
      return res.status(405).json({ error: 'Method not allowed' });
    }
    
    try {
      console.log('Request body:', req.body);
      
      const { html, validationType } = req.body;
      
      if (!html) {
        return res.status(400).json({ error: 'HTML content is required' });
      }
      
      if (!validationType) {
        return res.status(400).json({ error: 'Validation type is required' });
      }
      
      console.log('Validation type:', validationType);
      
      // For now, let's return a simple success response to test connectivity
      return res.status(200).json({
        success: true,
        message: 'Function is working',
        validationType: validationType,
        htmlLength: html.length,
        errors: [],
        fixCount: 0
      });
      
      // Comment out the Puppeteer logic for now to isolate the issue
      /*
      let result = { errors: [], fixCount: 0 };
      
      switch (validationType) {
        case 'undefined-variables':
          const undefinedErrors = await detectUndefinedVariableErrors(html);
          result = {
            errors: undefinedErrors,
            fixCount: undefinedErrors.length,
            type: 'undefined-variables'
          };
          break;
          
        // ... other cases
          
        default:
          return res.status(400).json({ error: 'Invalid validation type' });
      }
      
      return res.status(200).json(result);
      */
    } catch (error) {
      console.error('Function error:', error);
      console.error('Error stack:', error.stack);
      return res.status(500).json({ 
        error: 'Internal server error', 
        details: error.message,
        stack: error.stack
      });
    }
  }

function detectUnbalancedParentheses(source) {
  // Skip detection for shader-heavy content
  if (source.includes('ShaderMaterial') || 
      source.includes('vertexShader') || 
      source.includes('fragmentShader') ||
      source.includes('gl_FragColor') ||
      source.includes('uniform ') ||
      source.includes('varying ')) {
    console.log('Skipping parenthesis detection for shader content');
    return []; // Return no issues for shader content
  }
  
  const stack = [];
  const positions = [];
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (char === '(') {
      stack.push(i);
    } else if (char === ')') {
      if (stack.length === 0) {
        positions.push({ type: 'extra-close', index: i });
      } else {
        stack.pop();
      }
    }
  }
  for (const index of stack) {
    positions.push({ type: 'missing-close', index });
  }
  return positions;
}

async function getSmartFixFromAI(script, issues) {
  if (!issues || issues.length === 0) return { fixed: script, fixCount: 0 };
  
  try {
    // Create context for the AI
    const scriptLines = script.split('\n');
    const contextBlocks = [];
    
    // Group nearby issues into context blocks
    const issueIndices = issues.map(issue => issue.index);
    const lineIndices = new Map();
    
    // Map character indices to line numbers
    let charCounter = 0;
    scriptLines.forEach((line, lineIdx) => {
      for (let i = 0; i < line.length + 1; i++) {
        lineIndices.set(charCounter, lineIdx);
        charCounter++;
      }
    });
    
    // Create issue descriptions with line numbers
    const issueDescriptions = issues.map(issue => {
      const lineIdx = lineIndices.get(issue.index) || 0;
      const line = scriptLines[lineIdx] || '';
      const column = issue.index - charCounter + line.length;
      
      return {
        type: issue.type,
        lineNumber: lineIdx + 1,
        column: column,
        line: line,
        description: issue.type === 'missing-close' ? 
          'Missing closing parenthesis' : 
          'Extra closing parenthesis'
      };
    });
    
    // Create code context for each issue
    issueDescriptions.forEach(issue => {
      const startLine = Math.max(0, issue.lineNumber - 5);
      const endLine = Math.min(scriptLines.length, issue.lineNumber + 5);
      
      let contextBlock = `--- Context for ${issue.type} at line ${issue.lineNumber}, column ${issue.column} ---\n`;
      
      for (let i = startLine; i < endLine; i++) {
        const marker = i === issue.lineNumber - 1 ? '> ' : '  ';
        contextBlock += `${marker}${i + 1}: ${scriptLines[i]}\n`;
      }
      
      contextBlocks.push(contextBlock);
    });

    console.log("Here's the code context:  ", contextBlocks);
    
    // Create prompt for DeepSeek
    const prompt = `I have a JavaScript file with ${issues.length} parentheses issues. Please help me fix these issues WITHOUT rewriting the entire file - just apply targeted fixes.

Issues detected:
${issueDescriptions.map(issue => 
  `- ${issue.type} at line ${issue.lineNumber}, column ${issue.column}: ${issue.description}`
).join('\n')}

Here's the code context:

${contextBlocks.join('\n')}

IMPORTANT INSTRUCTIONS:
1. DO NOT rewrite the entire file - only provide specific fixes for each issue
2. For each fix, tell me:
   - The exact line number that needs to be fixed
   - The exact string that needs to be replaced
   - The exact string to replace it with
3. Format your answer as a JSON array of fix objects like this:
[
  {
    "lineNumber": 42,
    "original": "createFish(p.random(p.width), p.random(p.height), p.floor(p.random(3));",
    "fixed": "createFish(p.random(p.width), p.random(p.height), p.floor(p.random(3)));",
    "explanation": "Added missing closing parenthesis after p.random(3)"
  }
]
4. If a line has multiple issues, provide one fix that addresses all of them in a single replacement
5. Be precise about where to add or remove parentheses - consider the context carefully
6. DO NOT include explanations in the JSON, only the fix objects in the array`;

    console.log(`Asking DeepSeek AI for intelligent fix suggestions...`);

    // Call DeepSeek API
    const response = await axios.post('https://quiddit.ai/api/deepseek/chat/completions', {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: 'You are an expert JavaScript developer specializing in fixing syntax errors in P5.js code. You provide precise, targeted fixes for code issues without rewriting entire blocks of code.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 1024,
      temperature: 0.1
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      }
    });

    // Parse the AI response
    const aiResponse = response.data.choices[0].message.content;

    // Extract JSON array of fixes
    let fixesJson;
    try {
      // Look for JSON content within triple backticks
      const jsonMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      
      if (jsonMatch && jsonMatch[1]) {
        fixesJson = JSON.parse(jsonMatch[1].trim());
      } else {
        // Try to find a JSON array directly
        const jsonArrayMatch = aiResponse.match(/\[\s*{[\s\S]*}\s*\]/);
        if (jsonArrayMatch) {
          fixesJson = JSON.parse(jsonArrayMatch[0]);
        } else {
          throw new Error('Could not extract JSON fixes from AI response');
        }
      }
    } catch (e) {
      console.error('Error parsing AI response:', e);
      console.log('AI response was:', aiResponse);
      return { fixed: script, fixCount: 0 };
    }
    
    if (!Array.isArray(fixesJson) || fixesJson.length === 0) {
      console.log(`AI didn't provide any valid fixes.`);
      return { fixed: script, fixCount: 0 };
    }

    // Apply the fixes
    console.log(`Applying ${fixesJson.length} AI-suggested fixes...`);
    
    let fixedScript = script;
    let lines = fixedScript.split('\n');
    let fixCount = 0;
    
    fixesJson.forEach(fix => {
      const lineIndex = fix.lineNumber - 1;
      
      if (lineIndex >= 0 && lineIndex < lines.length) {
        const originalLine = lines[lineIndex];
        
        if (originalLine.includes(fix.original)) {
          // Simple string replacement if the original string is found exactly
          lines[lineIndex] = originalLine.replace(fix.original, fix.fixed);
          fixCount++;
          console.log(`✓ Fixed line ${fix.lineNumber}: ${fix.explanation || 'Applied AI-suggested fix'}`);
        } else {
          // Try more flexible replacement using similar string matching
          const similarity = calculateStringSimilarity(originalLine, fix.original);
          
          if (similarity > 0.7) { // If more than 70% similar
            lines[lineIndex] = fix.fixed;
            fixCount++;
            console.log(`✓ Fixed line ${fix.lineNumber}: ${fix.explanation || 'Applied AI-suggested fix'} (fuzzy match)`);
          } else {
            console.log(`⚠ Couldn't apply fix to line ${fix.lineNumber}: Original string not found`);
            
            // Fallback: Try to apply fix based on the issue type for this line
            const lineIssues = issueDescriptions.filter(issue => issue.lineNumber === fix.lineNumber);
            
            if (lineIssues.length > 0) {
              const issue = lineIssues[0];
              
              if (issue.type === 'missing-close') {
                // Add a closing parenthesis at the end of the line
                if (!originalLine.trim().endsWith(';')) {
                  lines[lineIndex] = originalLine + ')';
                } else {
                  lines[lineIndex] = originalLine.replace(';', ');');
                }
                fixCount++;
                console.log(`✓ Fixed line ${fix.lineNumber}: Added missing closing parenthesis (fallback method)`);
              } else if (issue.type === 'extra-close') {
                // Remove last closing parenthesis
                lines[lineIndex] = originalLine.replace(/\)([^)]*$)/, '$1');
                fixCount++;
                console.log(`✓ Fixed line ${fix.lineNumber}: Removed extra closing parenthesis (fallback method)`);
              }
            }
          }
        }
      } else {
        console.log(`⚠ Invalid line number in AI fix: ${fix.lineNumber}`);
      }
    });
    
    return {
      fixed: lines.join('\n'),
      fixCount: fixCount
    };
  } catch (error) {
    console.error('Error getting AI fixes:', error);
    // Fall back to simple fixes if AI fails
    return fixUnbalanced(script, false);
  }
}

// Simple fallback fix function
function fixUnbalanced(script, verbose = true) {
  let ast;
  try {
    ast = acornLoose.parse(script, { ecmaVersion: 'latest' });
  } catch (e) {
    // acorn-loose shouldn't throw — fallback only if something went truly wrong
    if (verbose) console.error("Critical parsing failure:", e.message);
    return { fixed: script, fixCount: 0 };
  }
  
  const parenFixes = detectUnbalancedParentheses(script);
  let fixedScript = script;
  let offset = 0;
  
  for (const fix of parenFixes) {
    if (fix.type === 'missing-close') {
      fixedScript = fixedScript.slice(0, fix.index + 1 + offset) + ')' + fixedScript.slice(fix.index + 1 + offset);
      offset += 1;
    } else if (fix.type === 'extra-close') {
      fixedScript = fixedScript.slice(0, fix.index + offset) + '/* removed extra ) */' + fixedScript.slice(fix.index + 1 + offset);
      offset += '/* removed extra ) */'.length - 1;
    }
  }
  
  if (verbose && parenFixes.length > 0) {
    console.log(`Fixed ${parenFixes.length} parenthesis issue(s) using basic method`);
  }
  
  return { fixed: fixedScript, fixCount: parenFixes.length };
}

async function extractAndFixScripts(html, verbose = true) {
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  let result = html;
  let totalFixes = 0;
  const matches = [];
  
  // Collect all script matches first
  while ((match = scriptRegex.exec(html)) !== null) {
    matches.push({
      fullMatch: match[0],
      scriptContent: match[1],
      index: match.index
    });
  }
  
  // Process scripts in parallel
  for (const match of matches) {
    const scriptContent = match.scriptContent;
    
    // Detect parenthesis issues
    const issues = detectUnbalancedParentheses(scriptContent);
    
    if (issues.length > 0) {
      // Use DeepSeek AI for intelligent fixes
      console.log(`Found ${issues.length} parenthesis issue(s) in script block`);
      
      const { fixed, fixCount } = await getSmartFixFromAI(scriptContent, issues);
      
      if (fixCount > 0) {
        const fixedScriptTag = match.fullMatch.replace(scriptContent, fixed);
        result = result.replace(match.fullMatch, fixedScriptTag);
        totalFixes += fixCount;
      } else {
        // Fallback to basic fixes if AI couldn't fix it
        console.log("AI couldn't fix the issues, falling back to basic fix method");
        const basicFix = fixUnbalanced(scriptContent, verbose);
        if (basicFix.fixCount > 0) {
          const fixedScriptTag = match.fullMatch.replace(scriptContent, basicFix.fixed);
          result = result.replace(match.fullMatch, fixedScriptTag);
          totalFixes += basicFix.fixCount;
        }
      }
    }
  }
  
  return { fixedHtml: result, totalFixes };
}

/**
 * Calculate similarity between two strings (simple implementation)
 * @param {string} str1 - First string
 * @param {string} str2 - Second string
 * @returns {number} - Similarity score (0-1)
 */
function calculateStringSimilarity(str1, str2) {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) {
    return 1.0;
  }
  
  // Count matching characters
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) {
      matches++;
    }
  }
  
  return matches / longer.length;
}


// Add this new function after the existing helper functions (around line 350)
async function fixShaderMaterialErrors(html) {
    console.log('Checking for THREE.ShaderMaterial shader compilation errors...');
    
    // Create a temporary file to test
    const tempFile = path.join(process.cwd(), '_temp_shader_check.html');
    fs.writeFileSync(tempFile, html, 'utf8');
    
    try {
        // Launch browser
        const browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        
        // Track shader errors
        const shaderErrors = [];
        
        // Listen for console messages containing SHADER_INFO
        page.on('console', (msg) => {
            const text = msg.text();
            if (text.includes('SHADER_INFO') || text.includes('THREE.WebGLProgram: Shader Error')) {
                shaderErrors.push(text);
            }
        });
        
        // Also listen for page errors that might contain shader info
        page.on('pageerror', (error) => {
            if (error.message.includes('SHADER_INFO') || error.message.includes('Shader Error')) {
                shaderErrors.push(error.message);
            }
        });
        
        // Load the page
        await page.goto(`file://${path.resolve(tempFile)}`, {
            waitUntil: 'networkidle0',
            timeout: 30000
        });
        
        // Wait for shaders to compile
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        await browser.close();
        
        // If no shader errors, return original
        if (shaderErrors.length === 0) {
            console.log('No THREE.ShaderMaterial compilation errors detected.');
            return { fixedHtml: html, fixCount: 0 };
        }
        
        console.log(`Found ${shaderErrors.length} shader compilation errors.`);
        
        // Extract ShaderMaterial blocks from HTML
        const shaderMaterialRegex = /new THREE\.ShaderMaterial\(\{[\s\S]*?\}\);?/g;
        let match;
        let fixedHtml = html;
        let fixCount = 0;
        
        while ((match = shaderMaterialRegex.exec(html)) !== null) {
            const shaderBlock = match[0];
            console.log('Found ShaderMaterial block, asking AI to fix shader syntax...');
            
            // Get AI fix for the entire ShaderMaterial
            const fixedShader = await getShaderMaterialFix(shaderBlock, shaderErrors[0]);
            
            if (fixedShader && fixedShader !== shaderBlock) {
                fixedHtml = fixedHtml.replace(shaderBlock, fixedShader);
                fixCount++;
                console.log('✓ Fixed ShaderMaterial syntax errors');
            }
        }
        
        return { fixedHtml, fixCount };
    } catch (error) {
        console.error('Error during shader error detection:', error);
        return { fixedHtml: html, fixCount: 0 };
    } finally {
        // Clean up temp file
        try {
            fs.unlinkSync(tempFile);
        } catch (e) {
            // Ignore cleanup errors
        }
    }
}

// Add this helper function
async function getShaderMaterialFix(shaderBlock, errorMessage) {
    const prompt = `Fix the syntax errors in this THREE.ShaderMaterial block. The browser reports this shader compilation error:

${errorMessage}

Here's the ShaderMaterial code with syntax issues:

\`\`\`javascript
${shaderBlock}
\`\`\`

IMPORTANT: Return ONLY the complete, corrected ShaderMaterial block with all syntax errors fixed. Do not add explanations or additional code.`;

    try {
        const response = await axios.post(DEEPSEEK_API_URL, {
            model: 'deepseek-chat',
            messages: [
                {
                    role: 'system',
                    content: 'You are an expert in THREE.js and GLSL shader programming. Fix shader syntax errors and return only the corrected code block.'
                },
                {
                    role: 'user',
                    content: prompt
                }
            ],
            max_tokens: 2048,
            temperature: 0.1
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
            }
        });

        const aiResponse = response.data.choices[0].message.content.trim();
        
        // Extract the ShaderMaterial block from the response
        const codeMatch = aiResponse.match(/```(?:javascript)?\s*([\s\S]*?)\s*```/);
        if (codeMatch && codeMatch[1]) {
            return codeMatch[1].trim();
        }
        
        // If no code blocks, assume the entire response is the fixed code
        return aiResponse;
    } catch (error) {
        console.error('Error getting shader fix from AI:', error);
        return null;
    }
}

// Add this helper function to detect if HTML contains ShaderMaterial
function containsShaderMaterial(html) {
    return /new THREE\.ShaderMaterial\(/i.test(html);
}


/**
 * Detect and fix incorrect CDN imports based on actual browser errors
 * @param {string} html - The HTML content to check
 * @returns {Object} - Object containing fixed HTML and fix count
 */
async function fixCdnImports(html) {
  console.log('Checking for CDN resource errors...');
  
  // Create a temporary file to test
  const tempFile = path.join(process.cwd(), '_temp_cdn_check.html');
  fs.writeFileSync(tempFile, html, 'utf8');
  
  try {
    // Launch browser
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    
    // Track failed resources and their URLs
    const failedResources = [];
    
    // Listen specifically for resource loading failures
    page.on('requestfailed', request => {
      const url = request.url();
      const failure = request.failure();
      
      // Only consider script/CSS resource failures, not images or other assets
      if ((url.includes('.js') || url.includes('/js/') || url.includes('script')) && 
          failure && failure.errorText) {
        console.log(`Resource failed to load: ${url} - ${failure.errorText}`);
        failedResources.push({
          url: url,
          error: failure.errorText
        });
      }
    });
    
    // Load the page and wait for resources to be attempted
    await page.goto(`file://${path.resolve(tempFile)}`, {
      waitUntil: 'networkidle0',
      timeout: 30000
    });
    
    await browser.close();
    
    // If no resource failures, we're done
    if (failedResources.length === 0) {
      console.log('No CDN resource loading errors detected.');
      return { fixedHtml: html, fixCount: 0 };
    }
    
    console.log(`Found ${failedResources.length} failed CDN resources that need fixing.`);
    
    // Extract script tags with external sources
    const scripts = [];
    const scriptRegex = /<script[^>]*src=["']([^"']+)["'][^>]*><\/script>/gi;
    let match;
    
    while ((match = scriptRegex.exec(html)) !== null) {
      scripts.push({
        fullTag: match[0],
        src: match[1],
        index: match.index
      });
    }
    
    // Identify scripts that match failed resources
    const problemScripts = [];
    
    failedResources.forEach(resource => {
      const resourceUrl = resource.url;
      
      // Find matching script - either exact match or close enough
      const matchingScript = scripts.find(script => {
        return resourceUrl.includes(script.src) || 
               script.src.includes(resourceUrl) ||
               // Handle relative vs absolute URLs
               (resourceUrl.includes('/') && script.src.includes('/') && 
                resourceUrl.split('/').pop() === script.src.split('/').pop());
      });
      
      if (matchingScript) {
        problemScripts.push({
          script: matchingScript,
          error: resource.error
        });
      }
    });
    
    if (problemScripts.length === 0) {
      console.log('Could not match failed resources to script tags.');
      return { fixedHtml: html, fixCount: 0 };
    }
    
    console.log(`Found ${problemScripts.length} problematic script tags to fix.`);
    
    // Fix each problematic script using AI
    let fixedHtml = html;
    let fixCount = 0;
    
    for (const problem of problemScripts) {
      console.log(`Asking DeepSeek AI for fix to script: ${problem.script.src}`);
      
      const prompt = `I need to fix this script tag that's failing to load:

\`${problem.script.fullTag}\`

The error is: "${problem.error}"

Please provide a working replacement for this script tag. The most common issues are:
1. Typo in the URL 
2. Using incorrect CDN domain
3. Incorrect package name (e.g., "p@1.8.0" instead of "p5@1.8.0")
4. Missing or invalid version number
5. Malformed URL syntax

Give me ONLY the full corrected script tag with no explanation.`;

      try {
        // Call DeepSeek API
        const response = await axios.post('https://quiddit.ai/api/deepseek/chat/completions', {
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content: 'You are an expert web developer. When given a broken script tag and error, provide only the corrected script tag with no additional explanation.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          max_tokens: 256,
          temperature: 0.1
        }, {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
          }
        });

        // Get the AI's suggested fix
        const aiResponse = response.data.choices[0].message.content.trim();
        
        // Extract just the script tag from the response
        const scriptTagMatch = aiResponse.match(/<script[^>]*>[^<]*<\/script>/);
        
        if (scriptTagMatch) {
          const fixedScriptTag = scriptTagMatch[0];
          
          // Only apply the fix if it's actually different
          if (fixedScriptTag !== problem.script.fullTag) {
            fixedHtml = fixedHtml.replace(problem.script.fullTag, fixedScriptTag);
            fixCount++;
            console.log(`✓ Fixed script tag: ${problem.script.src} → ${fixedScriptTag.match(/src=["']([^"']+)["']/)[1]}`);
          } else {
            console.log(`AI returned the same script tag, no changes needed.`);
          }
        } else {
          console.log(`Could not extract valid script tag from AI response: ${aiResponse}`);
        }
      } catch (error) {
        console.error('Error getting AI fix:', error);
      }
    }
    
    return { fixedHtml, fixCount };
  } catch (error) {
    console.error('Error during browser testing:', error);
    return { fixedHtml: html, fixCount: 0 };
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempFile);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Extract URL from console message
 * @param {string} message - Console message
 * @returns {string|null} - Extracted URL or null
 */
function extractUrlFromMessage(message) {
  if (!message) return null;
  
  // First try to find quoted URLs
  const quotedUrlMatch = message.match(/"((?:https?:)?\/\/[^"]+)"/);
  if (quotedUrlMatch) return quotedUrlMatch[1];
  
  // Then try finding URLs after common prefixes
  const prefixUrlMatch = message.match(/(?:from|at|resource:|loading)\s+((?:https?:)?\/\/[^\s]+)/i);
  if (prefixUrlMatch) return prefixUrlMatch[1];
  
  // Finally try to find any URL
  const anyUrlMatch = message.match(/((?:https?:)?\/\/[^\s"']+)/i);
  return anyUrlMatch ? anyUrlMatch[1] : null;
}

/**
 * Detect and fix CSS issues in style tags
 * @param {string} html - The HTML content to check
 * @returns {Object} - Object containing fixed HTML and fix count
 */
async function fixCssStyles(html) {
    // Find all style tags
    const styleRegex = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let match;
    let fixedHtml = html;
    let fixCount = 0;
    const matches = [];
    
    // Collect all style tag matches
    while ((match = styleRegex.exec(html)) !== null) {
      matches.push({
        fullMatch: match[0],
        cssContent: match[1],
        index: match.index
      });
    }
    
    // If no style tags found, return original HTML
    if (matches.length === 0) {
      return { fixedHtml, fixCount };
    }
    
    // Process each style tag
    for (const match of matches) {
      const cssContent = match.cssContent;
      
      // More accurate CSS validation check
      let hasErrors = false;
      const errorDetails = [];
      
      try {
        // Look for common CSS syntax errors, with improved accuracy
        
        // Check if we have property declarations without a selector
        const hasSelectorlessProperty = /^\s*[a-zA-Z0-9_-]+\s*:/.test(cssContent);
        if (hasSelectorlessProperty) {
          hasErrors = true;
          errorDetails.push("Found property declaration without selector");
        }
        
        // Count opening and closing braces
        const openBraces = (cssContent.match(/{/g) || []).length;
        const closeBraces = (cssContent.match(/}/g) || []).length;
        if (openBraces !== closeBraces) {
          hasErrors = true;
          errorDetails.push(`Unbalanced braces: ${openBraces} opening vs ${closeBraces} closing`);
        }
        
        // Check for obvious missing property names (just a colon at start of line)
        const missingPropertyName = /^\s*:\s+[^;]+;/m.test(cssContent);
        if (missingPropertyName) {
          hasErrors = true;
          errorDetails.push("Found property value without property name");
        }
        
        // Check for lines with only a colon between braces
        const colonOnlyProperty = /{[^}]*?\n\s*:[^;]+;/m.test(cssContent);
        if (colonOnlyProperty) {
          hasErrors = true;
          errorDetails.push("Found property with missing name");
        }
        
        // Check for invalid syntax like double colons in property (not pseudo-elements)
        const cssLines = cssContent.split('\n');
        for (let i = 0; i < cssLines.length; i++) {
          const line = cssLines[i].trim();
          // Count colons in a single property line, excluding valid pseudo-element syntax (::before, ::after)
          if (line && !line.startsWith('{') && !line.startsWith('}') && !line.startsWith('@') && !line.includes('::')) {
            const colonCount = (line.match(/:/g) || []).length;
            if (colonCount > 1 && !line.includes('@media') && !line.includes('@supports')) {
              hasErrors = true;
              errorDetails.push(`Multiple colons in property at line ${i+1}: ${line}`);
            }
          }
          
          // Check for semicolon inside a value bracket
          if (line.includes('(') && line.includes(');') && !line.endsWith(');')) {
            hasErrors = true;
            errorDetails.push(`Possible misplaced semicolon in function call at line ${i+1}: ${line}`);
          }
        }
        
        // Perform a clean/valid CSS test: all property lines within a rule should have a colon and end with semicolon
        // (except the last one, which might not have a semicolon before the closing brace)
        let inRule = false;
        let ruleHasErrors = false;
        let currentRuleLines = [];
        
        for (let i = 0; i < cssLines.length; i++) {
          const line = cssLines[i].trim();
          if (!line) continue; // Skip empty lines
          
          if (line.includes('{')) {
            inRule = true;
            currentRuleLines = [];
          } else if (line.includes('}')) {
            // Check the collected rule for errors
            if (ruleHasErrors) {
              hasErrors = true;
              errorDetails.push(`Rule ending at line ${i+1} has property syntax errors`);
            }
            inRule = false;
            ruleHasErrors = false;
            currentRuleLines = [];
          } else if (inRule) {
            currentRuleLines.push(line);
            
            // Check property format, but make sure we're not looking at a comment
            if (!line.startsWith('/*') && !line.endsWith('*/') && !line.startsWith('//')) {
              // Property line should have a colon
              if (!line.includes(':')) {
                ruleHasErrors = true;
              }
              
              // Property line should end with semicolon unless it's the last line before a closing brace
              const nextNonEmptyLine = findNextNonEmptyLine(cssLines, i);
              if (nextNonEmptyLine && !nextNonEmptyLine.includes('}') && !line.endsWith(';')) {
                ruleHasErrors = true;
              }
            }
          }
        }
        
        // Avoid false positives - specifically check if the CSS has key markers of validity
        const hasValidSelectors = /[a-zA-Z0-9_\-#.:]+ {/.test(cssContent); // Has at least one normal selector
        const hasValidProperties = /\s+[a-zA-Z0-9_\-]+\s*:/.test(cssContent); // Has at least one property name
        const hasValidValues = /:[^;]+;/.test(cssContent); // Has at least one property value
        
        // If we've detected errors but the CSS passes these basic validity tests, don't flag it
        if (hasErrors && hasValidSelectors && hasValidProperties && hasValidValues && errorDetails.length <= 1) {
          // This might be a false positive, especially if we only found one mild issue
          hasErrors = false;
          console.log(`Ignoring potential false positive in CSS validation`);
        }
        
      } catch (e) {
        // Only consider an exception as evidence of CSS errors if it's not a regex error
        if (!(e instanceof SyntaxError)) {
          hasErrors = true;
          errorDetails.push(`Exception during validation: ${e.message}`);
        }
      }
      
      if (hasErrors) {
        console.log(`Found CSS issues in style tag: ${errorDetails.join(', ')}`);
        
        try {
          // Extract the CSS content with context for the AI
          const cssLines = cssContent.split('\n');
          const lineNumbers = Array.from({ length: cssLines.length }, (_, i) => i + 1);
          
          const cssWithLineNumbers = cssLines.map((line, i) => 
            `${lineNumbers[i].toString().padStart(3)}: ${line}`
          ).join('\n');
          
          // Create prompt for DeepSeek
          const prompt = `I have CSS code in a style tag with potential syntax issues. Please help me fix these issues.
  
  Here's the CSS content:
  \`\`\`css
  ${cssWithLineNumbers}
  \`\`\`
  
  Detected issues: ${errorDetails.join(', ')}
  
  IMPORTANT INSTRUCTIONS:
  1. FIX ONLY ACTUAL SYNTAX ERRORS. If the CSS is already correct, say "NO_CHANGES_NEEDED".
  2. Fix syntax errors (missing semicolons, properties, invalid values, etc.)
  3. Keep the same selectors and general styling intent
  4. Provide the COMPLETE fixed CSS block
  5. Do not add new styles or remove intentional styles
  6. Format the CSS consistently
  7. If a property is missing a name before the colon, use an appropriate property name based on context
  
  RESPOND WITH JUST THE FIXED CSS CONTENT, starting with the first selector and ending with the last closing brace. If no changes are needed, just respond with "NO_CHANGES_NEEDED".`;
  
          console.log(`Asking DeepSeek AI for CSS fixes...`);
  
          // Call DeepSeek API
          const response = await axios.post('https://quiddit.ai/api/deepseek/chat/completions', {
            model: 'deepseek-chat',
            messages: [
              {
                role: 'system',
                content: 'You are an expert CSS developer who specializes in fixing syntax errors in CSS code. You provide complete, fixed CSS code that maintains the original styling intent while fixing all syntax issues. You only make changes when actual errors exist.'
              },
              {
                role: 'user',
                content: prompt
              }
            ],
            max_tokens: 1024,
            temperature: 0.1
          }, {
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
            }
          });
  
          // Parse the AI response
          const aiResponse = response.data.choices[0].message.content.trim();
          
          // If the AI says no changes needed, accept that
          if (aiResponse === "NO_CHANGES_NEEDED") {
            console.log(`✓ AI confirms CSS is valid, no changes needed`);
            continue;
          }
          
          // Check if the response is a valid CSS block
          if (aiResponse && (aiResponse.includes('{') || aiResponse.includes('}'))) {
            // Extract just the CSS content, ignoring any markdown or explanations
            let fixedCss = aiResponse;
            
            // If the response has code blocks, extract the content
            const cssBlock = aiResponse.match(/```css\s*([\s\S]*?)\s*```/);
            if (cssBlock && cssBlock[1]) {
              fixedCss = cssBlock[1].trim();
            }
            
            // Additional cleanup - remove any non-CSS lines like "Here's the fixed CSS:"
            fixedCss = fixedCss.replace(/^(?![\s{}.#a-zA-Z0-9@*:-]).+$\n?/gm, '').trim();
            
            // Compare to see if any actual changes were made
            const normalizedOriginal = cssContent.replace(/\s+/g, ' ').trim();
            const normalizedFixed = fixedCss.replace(/\s+/g, ' ').trim();
            
            if (normalizedOriginal !== normalizedFixed) {
              // Replace the style content in the HTML
              const fixedStyleTag = match.fullMatch.replace(cssContent, '\n' + fixedCss + '\n    ');
              fixedHtml = fixedHtml.replace(match.fullMatch, fixedStyleTag);
              fixCount++;
              console.log(`✓ Fixed CSS issues in style tag`);
            } else {
              console.log(`✓ AI confirmed CSS is valid (no changes needed)`);
            }
          } else {
            console.log(`⚠️ AI response didn't contain valid CSS, using fallback method`);
            
            // Basic fallback: fix common issues
            let fixedCss = cssContent;
            
            // Fix missing property name (just a colon with no property name)
            fixedCss = fixedCss.replace(/(\s+): /g, '$1position: ');
            
            // Fix missing semicolons
            fixedCss = fixedCss.replace(/([^;{}])\s*}/g, '$1;}');
            
            // Replace the style content in the HTML only if changes were made
            const normalizedOriginal = cssContent.replace(/\s+/g, ' ').trim();
            const normalizedFixed = fixedCss.replace(/\s+/g, ' ').trim();
            
            if (normalizedOriginal !== normalizedFixed) {
              const fixedStyleTag = match.fullMatch.replace(cssContent, fixedCss);
              fixedHtml = fixedHtml.replace(match.fullMatch, fixedStyleTag);
              fixCount++;
              console.log(`✓ Fixed CSS issues using fallback method`);
            } else {
              console.log(`No changes needed after analysis`);
            }
          }
        } catch (error) {
          console.error('Error getting CSS fixes from AI:', error);
          
          // Very basic fallback
          let fixedCss = cssContent;
          
          // Fix missing property name (just a colon with no property name)
          fixedCss = fixedCss.replace(/(\s+): /g, '$1position: ');
          
          // Fix missing semicolons
          fixedCss = fixedCss.replace(/([^;{}])\s*}/g, '$1;}');
          
          // Replace the style content in the HTML only if changes were made
          const normalizedOriginal = cssContent.replace(/\s+/g, ' ').trim();
          const normalizedFixed = fixedCss.replace(/\s+/g, ' ').trim();
          
          if (normalizedOriginal !== normalizedFixed) {
            const fixedStyleTag = match.fullMatch.replace(cssContent, fixedCss);
            fixedHtml = fixedHtml.replace(match.fullMatch, fixedStyleTag);
            fixCount++;
            console.log(`✓ Fixed CSS issues using basic fallback method (after AI error)`);
          }
        }
      }
    }
    
    return { fixedHtml, fixCount };
  }
  
  // Helper function to find the next non-empty line
  function findNextNonEmptyLine(lines, currentIndex) {
    for (let i = currentIndex + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line) return line;
    }
    return null;
  }


    /**
     * Fix malformed HTML tags that use HTML entities
     * @param {string} html - The HTML content to check
     * @returns {Object} - Object containing fixed HTML and fix count
     */
    function fixMalformedHtmlTags(html) {
        let fixedHtml = html;
        let fixCount = 0;
        
        // Pattern to match malformed script tags using HTML entities
        const malformedScriptPattern = /&lt;\s*(?:script)?\s*src="([^"]+)"(?:\s*&gt;)?/gi;
        
        // Find all malformed script tags
        let match;
        while ((match = malformedScriptPattern.exec(html)) !== null) {
        const fullMatch = match[0];
        const srcUrl = match[1];
        
        // Create proper script tag
        const correctTag = `<script src="${srcUrl}"></script>`;
        
        // Replace in the HTML
        fixedHtml = fixedHtml.replace(fullMatch, correctTag);
        fixCount++;
        
        console.log(`✓ Fixed malformed script tag: ${srcUrl}`);
        }
        
        // Look for malformed title tags
        const malformedTitlePattern = /&lt;\s*&gt;\s*([^<]+)(?:<\/title>)?/gi;
        while ((match = malformedTitlePattern.exec(html)) !== null) {
        const fullMatch = match[0];
        const titleContent = match[1];
        
        // Create proper title tag
        const correctTag = `<title>${titleContent}</title>`;
        
        // Replace in the HTML
        fixedHtml = fixedHtml.replace(fullMatch, correctTag);
        fixCount++;
        
        console.log(`✓ Fixed malformed title tag: "${titleContent}"`);
        }
        
        // Look for other entity-encoded HTML tags
        const entityTagPattern = /&lt;([a-zA-Z]+)([^&]*)&gt;/g;
        let entityMatch;
        
        while ((entityMatch = entityTagPattern.exec(html)) !== null) {
        const fullMatch = entityMatch[0];
        const tagName = entityMatch[1];
        const attributes = entityMatch[2];
        
        // Only fix important tags to avoid messing with intentional HTML displays
        const criticalTags = ['script', '/script', 'title', '/title', 'style', '/style', 'link', 'meta'];
        if (criticalTags.includes(tagName)) {
            const correctTag = `<${tagName}${attributes}>`;
            fixedHtml = fixedHtml.replace(fullMatch, correctTag);
            fixCount++;
            console.log(`✓ Fixed malformed ${tagName} tag`);
        }
        }
        
        return { fixedHtml, fixCount };
    }

/**
 * Fix CSS content not wrapped in style tags
 * @param {string} html - The HTML content to check
 * @returns {Object} - Object containing fixed HTML and fix count
 */
function fixMissingStyleTags(html) {
    let fixedHtml = html;
    let fixCount = 0;
    
    // First, check for the most common pattern - CSS immediately after a script, title, or meta tag
    const commonPatterns = [
        /<\/script>\s*(\s*body\s*\{[^<]+?\}.*?(?=<\w+|$))/s,
        /<\/title>\s*(\s*body\s*\{[^<]+?\}.*?(?=<\w+|$))/s,
        /<meta[^>]*>\s*(\s*body\s*\{[^<]+?\}.*?(?=<\w+|$))/s,
        /<head>\s*(\s*body\s*\{[^<]+?\}.*?(?=<\w+|$))/s
    ];
    
    for (const pattern of commonPatterns) {
        const match = pattern.exec(html);
        if (match) {
            const potentialCss = match[1];
            
            // Verify this looks like real CSS
            if (isLikelyCss(potentialCss)) {
                console.log('Found CSS content not wrapped in style tags');
                
                // Wrap the CSS in style tags
                const styledCss = `<style>\n${potentialCss}\n</style>`;
                fixedHtml = fixedHtml.replace(potentialCss, styledCss);
                fixCount++;
                console.log(`✓ Wrapped CSS content in style tags`);
                
                // Since we've made a replacement, run the function again to catch any other instances
                // (but only if we haven't exceeded a reasonable number of fixes to prevent infinite loops)
                if (fixCount < 5) {
                    const recursiveResult = fixMissingStyleTags(fixedHtml);
                    fixedHtml = recursiveResult.fixedHtml;
                    fixCount += recursiveResult.fixCount;
                }
                
                return { fixedHtml, fixCount };
            }
        }
    }
    
    // More aggressive pattern to catch CSS anywhere in the document
    // Only use if no style tags exist already or if we haven't found anything yet
    if (fixCount === 0 && !/<style[^>]*>/.test(html)) {
        // Look for blocks that start with common CSS selectors and contain typical CSS patterns
        const standalonePattern = /(?:^|\n|\r)(\s*(?:body|html|#[\w-]+|\.[\w-]+)[^{<>]*\{[^}]+\}(?:\s*[\w.#*:][^{<>]*\{[^}]+\})*)/;
        const match = standalonePattern.exec(html);
        
        if (match) {
            const potentialCss = match[1];
            
            if (isLikelyCss(potentialCss)) {
                console.log('Found standalone CSS content not wrapped in style tags');
                
                // Wrap the CSS in style tags
                const styledCss = `<style>\n${potentialCss}\n</style>`;
                
                // Determine where to insert the style tag
                if (html.includes('</head>')) {
                    // Insert before head closing tag
                    fixedHtml = html.replace('</head>', `${styledCss}\n</head>`);
                } else if (html.includes('<body')) {
                    // Insert before body tag
                    fixedHtml = html.replace('<body', `${styledCss}\n<body`);
                } else {
                    // Default: replace the CSS block directly
                    fixedHtml = html.replace(potentialCss, styledCss);
                }
                
                fixCount++;
                console.log(`✓ Wrapped standalone CSS content in style tags`);
            }
        }
    }
    
    return { fixedHtml, fixCount };
}

/**
 * Helper function to determine if text is likely to be CSS
 * @param {string} text - Text to analyze
 * @returns {boolean} - Whether the text appears to be CSS
 */
function isLikelyCss(text) {
    // CSS should have property:value pairs
    const hasCssProperties = /[a-zA-Z-]+\s*:\s*[^;{}]+(;|\})/.test(text);
    
    // CSS should have at least one CSS rule (selector followed by braces)
    const hasCssRules = /[a-zA-Z#.][^{]*\{[^}]*\}/.test(text);
    
    // Make sure we're not matching JavaScript or other code
    const looksLikeCode = /function |var |const |let |return |if \(|else |for \(|while \(/.test(text);
    
    // Check for common CSS properties
    const hasCommonCssProps = /(margin|padding|background|color|font|width|height|position|display)/.test(text);
    
    // Additional check: for very short pieces, require more evidence
    if (text.length < 100) {
        return hasCssProperties && hasCssRules && hasCommonCssProps && !looksLikeCode;
    }
    
    return hasCssProperties && hasCssRules && !looksLikeCode;
}

/**
 * Extract scripts from HTML
 * @param {string} htmlContent - HTML content
 * @returns {Array} - Array of script objects
 */
function extractScripts(htmlContent) {
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  const scripts = [];
  
  let match;
  while ((match = scriptRegex.exec(htmlContent)) !== null) {
    const scriptContent = match[1];
    if (!scriptContent.trim()) continue; // Skip empty scripts
    
    // Calculate line numbers for later reference
    const codeUpToScript = htmlContent.substring(0, match.index);
    const startLine = (codeUpToScript.match(/\n/g) || []).length + 1;
    const scriptLines = scriptContent.split('\n').length;
    
    scripts.push({
      content: scriptContent,
      fullMatch: match[0],
      index: match.index,
      lineRange: [startLine, startLine + scriptLines - 1]
    });
  }
  
  return scripts;
}

/**
 * Check if a variable is declared inside a conditional block
 * @param {string} code - The script content
 * @param {string} varName - The variable name to check
 * @returns {Object} - Result of the check
 */
function checkConditionalDeclaration(code, varName) {
  const lines = code.split('\n');
  const result = {
    found: false,
    lineNumber: null,
    line: null,
    blockType: null
  };
  
  // Regular expression to match variable declarations inside conditional blocks
  const varDeclPattern = new RegExp(`\\b(var|let|const)\\s+${varName}\\b`);
  
  // Track block nesting
  let blockStack = [];
  let blockTypes = [];
  let inConditionalBlock = false;
  let conditionalType = null;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check for conditional statement openings
    if (/\b(if|else|for|while|switch|try|catch)\b.*{/.test(line)) {
      const type = line.match(/\b(if|else|for|while|switch|try|catch)\b/)[1];
      blockStack.push(i);
      blockTypes.push(type);
      inConditionalBlock = true;
      conditionalType = type;
    } 
    // Check for opening braces on their own line
    else if (/^\s*{/.test(line) && blockTypes.length > 0) {
      blockStack.push(i);
    }
    // Check for closing braces
    else if (/^\s*}/.test(line) && blockStack.length > 0) {
      blockStack.pop();
      if (blockTypes.length > 0) {
        blockTypes.pop();
      }
      inConditionalBlock = blockStack.length > 0;
      conditionalType = blockTypes.length > 0 ? blockTypes[blockTypes.length - 1] : null;
    }
    
    // Check for variable declaration
    if (varDeclPattern.test(line) && inConditionalBlock) {
      result.found = true;
      result.lineNumber = i + 1;
      result.line = line;
      result.blockType = conditionalType;
      break;
    }
  }
  
  return result;
}


    
/**
 * Fix undefined variable errors in JavaScript code
 * @param {string} html - The HTML content to check
 * @returns {Promise<Object>} - Object containing fixed HTML and fix count
 */
async function fixUndefinedVariables(html) {
  // Find all script tags
  const scripts = extractScripts(html);
  if (scripts.length === 0) {
    return { fixedHtml: html, fixCount: 0 };
  }
  
  console.log('Checking for undefined variable errors...');
  
  // Detect undefined variable errors using browser
  const errors = await detectUndefinedVariableErrors(html);
  
  if (errors.length === 0) {
    console.log('No undefined variable errors detected.');
    return { fixedHtml: html, fixCount: 0 };
  }
  
  console.log(`Found ${errors.length} undefined variable errors.`);
  
  // Group errors by variable name
  const errorsByVariable = {};
  errors.forEach(error => {
    const varName = extractVarNameFromError(error.message);
    if (varName) {
      if (!errorsByVariable[varName]) {
        errorsByVariable[varName] = [];
      }
      errorsByVariable[varName].push(error);
    }
  });
  
  const variableNames = Object.keys(errorsByVariable);
  console.log(`Unique undefined variables: ${variableNames.join(', ')}`);
  
  let fixedHtml = html;
  let totalFixCount = 0;
  
  // Fix each undefined variable
  for (const varName of variableNames) {
    console.log(`Generating fix for undefined variable: ${varName}`);
    const varErrors = errorsByVariable[varName];
    
    // Find all scripts that reference this variable
    for (let i = 0; i < scripts.length; i++) {
      const script = scripts[i];
      const scriptContent = script.content;
      
      // Check if this script contains references to the variable
      if (new RegExp(`\\b${varName}\\b`, 'g').test(scriptContent)) {
        // Get fix for this script and variable
        const fixResult = await getVariableFixFromAI(scriptContent, varName, varErrors[0]);
        
        if (fixResult.success && fixResult.fixes && fixResult.fixes.length > 0) {
          // Apply the fixes to the script
          let fixedScript = scriptContent;
          
          // If this is an automatic fix for a conditional declaration
          if (fixResult.automaticFix) {
            const fix = fixResult.fixes[0];
            
            // Special handling for top-level insertion
            if (fix.lineNumber === 1) {
              const lines = scriptContent.split('\n');
              lines.unshift(fix.replacement.split('\n')[0]);
              fixedScript = lines.join('\n');
              console.log(`✓ Added global declaration for '${varName}' at top of script`);
              totalFixCount++;
            } else {
              // Apply normal line replacement
              const lines = scriptContent.split('\n');
              lines[fix.lineNumber - 1] = fix.replacement;
              fixedScript = lines.join('\n');
              console.log(`✓ Fixed conditional declaration for '${varName}' at line ${fix.lineNumber}`);
              totalFixCount++;
            }
          } 
          // Normal AI-generated fixes
          else {
            const scriptLines = fixedScript.split('\n');
            let changedLines = 0;
            
            fixResult.fixes.forEach(fix => {
              console.log(`✓ Variable fix for '${varName}': ${fix.explanation}`);
              
              // Check if we have a line number and it's valid
              if (fix.lineNumber && fix.lineNumber > 0 && fix.lineNumber <= scriptLines.length) {
                const lineIdx = fix.lineNumber - 1;
                const actualLine = scriptLines[lineIdx];
                
                console.log(`  Line ${fix.lineNumber}:`);
                console.log(`  Before: ${actualLine}`);
                console.log(`  After:  ${fix.replacement}`);
                
                // Direct line replacement
                scriptLines[lineIdx] = fix.replacement;
                changedLines++;
                totalFixCount++;
              } 
              // If we have original text but no line number
              else if (fix.original) {
                // Try to find the original text in the script
                if (fixedScript.includes(fix.original)) {
                  fixedScript = fixedScript.replace(fix.original, fix.replacement);
                  changedLines++;
                  totalFixCount++;
                  
                  console.log(`  Before: ${fix.original}`);
                  console.log(`  After:  ${fix.replacement}`);
                } else {
                  // If automatic fix failed, add declaration at the top
                  scriptLines.unshift(`let ${varName} = { uniforms: { value: { x: 0, y: 0 } } }; // Auto-declared at top level to fix undefined error`);
                  changedLines++;
                  totalFixCount++;
                  
                  console.log(`  Added declaration at script start for ${varName}`);
                }
              }
            });
            
            if (changedLines > 0 && fixResult.fixes.length > 0) {
              fixedScript = scriptLines.join('\n');
            }
          }
          
          // Replace the script in the HTML
          const fixedScriptTag = script.fullMatch.replace(script.content, fixedScript);
          fixedHtml = fixedHtml.replace(script.fullMatch, fixedScriptTag);
        } else {
          // If AI fix failed, apply simple global declaration
          console.log(`⚠️ Fix unavailable, applying global declaration for ${varName}`);
          
          const lines = scriptContent.split('\n');
          lines.unshift(`let ${varName} = { uniforms: { value: { x: 0, y: 0 } } }; // Added global declaration as fallback fix`);
          const fixedScript = lines.join('\n');
          
          const fixedScriptTag = script.fullMatch.replace(script.content, fixedScript);
          fixedHtml = fixedHtml.replace(script.fullMatch, fixedScriptTag);
          totalFixCount++;
        }
      }
    }
  }
  
  console.log(`Applied ${totalFixCount} fixes for undefined variables.`);
  return { fixedHtml, fixCount: totalFixCount };
}

/**
 * Detect undefined variable errors using a headless browser
 * @param {string} html - HTML content to check
 * @returns {Promise<Array>} - Array of error objects
 */
async function detectUndefinedVariableErrors(html) {
  console.log('Launching browser to detect undefined variable errors...');
  
  // Write HTML to a temporary file
  const tempFile = path.join(process.cwd(), '_temp_undefined_check.html');
  fs.writeFileSync(tempFile, html, 'utf8');
  
  try {
    // Launch browser
    const browser = await puppeteer.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();
    
    // Collect errors
    const errors = [];
    
    // Setup error handler for ReferenceErrors specifically
    page.on('pageerror', (error) => {
      if (error.name === 'ReferenceError' || error.message.includes('is not defined')) {
        errors.push({
          type: 'reference',
          message: error.message,
          stack: error.stack || '',
          lineNumber: extractLineNumberFromStack(error.stack)
        });
      }
    });
    
    // Capture console errors that might be related to undefined variables
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (text.includes('is not defined') || text.includes('ReferenceError')) {
          errors.push({
            type: 'console',
            message: text,
            lineNumber: extractLineNumberFromMessage(text)
          });
        }
      }
    });
    
    try {
      // Load the HTML file
      await page.goto(`file://${path.resolve(tempFile)}`, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });
      
      // Wait to ensure all scripts execute
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Process and deduplicate the errors
      return deduplicateErrors(errors);
    } finally {
      await browser.close();
    }
  } catch (error) {
    console.error('Error during browser testing:', error);
    return [];
  } finally {
    // Clean up temp file
    try {
      fs.unlinkSync(tempFile);
    } catch (e) {
      // Ignore cleanup errors
    }
  }
}

/**
 * Extract variable name from error message
 * @param {string} errorMessage - Error message
 * @returns {string|null} - Extracted variable name or null
 */
function extractVarNameFromError(errorMessage) {
  // Pattern: "ReferenceError: foo is not defined"
  // or "Uncaught ReferenceError: foo is not defined"
  const regex = /(?:ReferenceError:|Error:)?\s*([a-zA-Z0-9_$]+) is not defined/i;
  const match = errorMessage.match(regex);
  return match ? match[1] : null;
}

/**
 * Extract line number from error stack trace
 * @param {string} stack - Error stack trace
 * @returns {number|null} - Line number or null
 */
function extractLineNumberFromStack(stack) {
  if (!stack) return null;
  // Look for line number in stack trace
  const lineMatch = stack.match(/:(\d+):(\d+)/);
  return lineMatch ? parseInt(lineMatch[1], 10) : null;
}

/**
 * Extract line number from error message
 * @param {string} message - Error message
 * @returns {number|null} - Line number or null
 */
function extractLineNumberFromMessage(message) {
  const lineMatch = message.match(/line\s+(\d+)/i);
  return lineMatch ? parseInt(lineMatch[1], 10) : null;
}

/**
 * Remove duplicate errors
 * @param {Array} errors - Array of error objects
 * @returns {Array} - Deduplicated array
 */
function deduplicateErrors(errors) {
  const seen = new Set();
  return errors.filter(error => {
    const varName = extractVarNameFromError(error.message);
    if (!varName) return false;
    
    // Create a unique key for each error
    const key = `${varName}:${error.lineNumber || 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
/**
 * Get fixes for undefined variables from DeepSeek AI
 * @param {string} scriptContent - JavaScript code
 * @param {string} varName - Name of the undefined variable
 * @param {Object} error - Error object
 * @returns {Promise<Object>} - Fix result
 */
async function getVariableFixFromAI(scriptContent, varName, error) {
  console.log(`🤖 Analyzing code structure for undefined variable: ${varName}`);
  
  // First, check if the variable is declared in a conditional block that might not execute
  const conditionalDeclarationCheck = checkConditionalDeclaration(scriptContent, varName);
  if (conditionalDeclarationCheck.found) {
    console.log(`⚠️ Found ${varName} declared in a conditional block that may not execute:`);
    console.log(`   Line ${conditionalDeclarationCheck.lineNumber}: ${conditionalDeclarationCheck.line.trim()}`);
    console.log(`   Inside block: ${conditionalDeclarationCheck.blockType}`);
    
    // Return a specific fix for this case without calling the AI
    return {
      success: true,
      fixes: [{
        lineNumber: 1, // Add to top of script
        original: scriptContent.split('\n')[0],
        replacement: `let ${varName} = { uniforms: { value: { x: 0, y: 0 } } }; // Added at top level to fix variable scoping issue\n${scriptContent.split('\n')[0]}`,
        explanation: `Moved ${varName} declaration outside conditional block to ensure it's always defined`
      }],
      varName,
      automaticFix: true
    };
  }
  
  // If not a conditional declaration issue, proceed with normal AI-assisted fix
  console.log(`🤖 Asking DeepSeek AI for undefined variable fix: ${varName}`);
  
  try {
    // Split script into lines for context
    const scriptLines = scriptContent.split('\n');
    
    // Find all occurrences of the variable
    const varRegex = new RegExp(`\\b${varName}\\b`, 'g');
    const varOccurrences = [];
    let match;
    
    while ((match = varRegex.exec(scriptContent)) !== null) {
      // Find line number for this occurrence
      const upToMatch = scriptContent.substring(0, match.index);
      const lineNumber = (upToMatch.match(/\n/g) || []).length + 1;
      
      // Get context around this occurrence
      const startLine = Math.max(0, lineNumber - 5);
      const endLine = Math.min(scriptLines.length, lineNumber + 5);
      
      const contextLines = scriptLines.slice(startLine, endLine);
      const contextWithLine = contextLines.map((line, i) => {
        const currentLineNum = startLine + i + 1;
        return `${currentLineNum === lineNumber ? '>' : ' '} ${currentLineNum}: ${line}`;
      }).join('\n');
      
      varOccurrences.push({
        lineNumber,
        context: contextWithLine,
        actualLine: scriptLines[lineNumber - 1]
      });
    }
    
    // Prepare prompt for DeepSeek
    const prompt = `I need an EMERGENCY FIX for an undefined variable in my JavaScript code. The browser is reporting this error:

ERROR: ${error.message}

The undefined variable is: "${varName}"

I need you to provide the MINIMAL POSSIBLE CHANGES to make the code execute without errors. Here are all occurrences of the variable in the code:

${varOccurrences.map((occ, i) => `
OCCURRENCE ${i+1} (Line ${occ.lineNumber}):
\`\`\`javascript
${occ.context}
\`\`\`
ACTUAL LINE TO FIX: "${occ.actualLine.trim()}"
`).join('\n')}

IMPORTANT INSTRUCTIONS:
1. DO NOT rewrite the entire code - just make the smallest possible changes to fix the error
2. Consider these approaches, in order of preference:
   a) Add a defensive null check (e.g., \`if (${varName}) {...}\` or \`${varName} && ${varName}.property\`)
   b) Initialize the variable with a sensible default value
   c) Add a variable declaration at the appropriate scope
3. Format your answer as a JSON array of fix objects like this:
[
  {
    "lineNumber": exact_line_number,
    "original": "EXACT original line to replace (must match exactly)",
    "replacement": "complete replacement line",
    "explanation": "Brief explanation of what the fix does"
  }
]
4. Make sure the 'original' field EXACTLY matches an entire line in the code
5. Provide complete line replacements, not partial snippets
6. If multiple approaches are possible, choose the SAFEST one that will prevent runtime errors

Remember, this is an EMERGENCY FIX - prioritize getting the code to run without errors over perfect code.`;

    // Call DeepSeek API
    const response = await axios.post(DEEPSEEK_API_URL, {
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: 'You are an expert JavaScript developer specializing in emergency fixes for undefined variable errors. You provide minimal, targeted fixes that allow code to compile and run without errors.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: 1024,
      temperature: 0.1
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
      }
    });

    // Parse the AI response
    const aiResponse = response.data.choices[0].message.content;
    console.log('AI RESPONSE:', aiResponse);
    
    // Extract JSON fixes from the response
    let fixes;
    try {
      // Look for JSON array in code blocks
      const jsonMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        fixes = JSON.parse(jsonMatch[1].trim());
      } else {
        // Try to find JSON array directly
        const jsonArrayMatch = aiResponse.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonArrayMatch) {
          fixes = JSON.parse(jsonArrayMatch[0]);
        } else {
          throw new Error('Could not extract JSON fixes from AI response');
        }
      }
      
      if (!Array.isArray(fixes)) {
        fixes = [fixes]; // Convert single object to array
      }
      
      return {
        success: true,
        fixes,
        varName
      };
    } catch (e) {
      console.error('Error parsing AI response:', e);
      console.log('AI response was:', aiResponse);
      
      // Try to extract the fix manually using regex
      const originalMatch = aiResponse.match(/original["']:\s*["']([^"']+)["']/);
      const replacementMatch = aiResponse.match(/replacement["']:\s*["']([^"']+)["']/);
      const explanationMatch = aiResponse.match(/explanation["']:\s*["']([^"']+)["']/);
      const lineNumMatch = aiResponse.match(/lineNumber["']:\s*(\d+)/);
      
      if (lineNumMatch && (originalMatch || replacementMatch)) {
        const lineNum = parseInt(lineNumMatch[1]);
        const originalLine = originalMatch ? originalMatch[1] : scriptLines[lineNum - 1];
        const replacementLine = replacementMatch ? replacementMatch[1] : 
                               `let ${varName} = window.${varName} || {}; // Added declaration to fix undefined error`;
                               
        return {
          success: true,
          fixes: [{
            lineNumber: lineNum,
            original: originalLine,
            replacement: replacementLine,
            explanation: explanationMatch ? explanationMatch[1] : 'Manual extraction from AI response'
          }],
          varName
        };
      }
      
      // If all else fails, find the first occurrence and create a simple variable declaration
      if (varOccurrences.length > 0) {
        const firstOccurrence = varOccurrences[0];
        
        return {
          success: true,
          fixes: [{
            lineNumber: firstOccurrence.lineNumber,
            original: firstOccurrence.actualLine,
            replacement: firstOccurrence.actualLine.replace(
              new RegExp(`\\b${varName}\\b`), 
              `(window.${varName} || {})`
            ),
            explanation: 'Added defensive global null check (fallback method)'
          }],
          varName
        };
      }
      
      // Ultimate fallback - add declaration to first line with this variable
      const varLine = scriptLines.findIndex(line => line.includes(varName));
      if (varLine >= 0) {
        return {
          success: true,
          fixes: [{
            lineNumber: varLine + 1,
            original: scriptLines[varLine],
            replacement: `let ${varName} = {}; // Auto-declared to fix error\n${scriptLines[varLine]}`,
            explanation: 'Added variable declaration as fallback fix'
          }],
          varName
        };
      }
      
      return { success: false };
    }
  } catch (error) {
    console.error('Error getting variable fix from AI:', error);
    return { success: false };
  }
}

/**
 * Fix "is not a function" TypeError errors using targeted code patching
 * @param {string} html - The HTML content to check
 * @returns {Promise<Object>} - Object containing fixed HTML and fix count
 */
async function fixNotAFunctionErrors(html) {
    // Extract all scripts
    const scripts = extractScripts(html);
    let fixedHtml = html;
    let fixCount = 0;
    
    // Create a temporary file for testing
    const tempFile = path.join(process.cwd(), '_temp_function_check.html');
    fs.writeFileSync(tempFile, html, 'utf8');
    
    try {
      // Launch browser to catch errors
      const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
      const page = await browser.newPage();
      
      // Track TypeError errors
      const errorDetails = [];
      
      // Capture page errors
      page.on('pageerror', (error) => {
        if (error.message.includes('is not a function')) {
          errorDetails.push({
            message: error.message,
            stack: error.stack || ""
          });
        }
      });
      
      // Capture console errors
      page.on('console', (msg) => {
        if (msg.type() === 'error') {
          const text = msg.text();
          if (text.includes('is not a function') || 
              text.includes('TypeError') || 
              text.includes('UNCAUGHT_EXCEPTION')) {
            errorDetails.push({
              message: text,
              consoleError: true
            });
          }
        }
      });
      
      // Load the page
      await page.goto(`file://${path.resolve(tempFile)}`, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });
      
      // Wait for errors to be caught
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      await browser.close();
      
      // If no errors, return original
      if (errorDetails.length === 0) {
        console.log('No "is not a function" errors detected.');
        return { fixedHtml, fixCount };
      }
      
      console.log(`Found ${errorDetails.length} function-related errors.`);
      
      // Extract the function details from errors
      const functionData = extractFunctionDetailsFromErrors(errorDetails);
      if (functionData.length === 0) {
        console.log('Could not identify specific function names from errors.');
        return { fixedHtml, fixCount };
      }
      
      console.log(`Identified problematic functions:`, 
        functionData.map(f => `${f.objectName}.${f.functionName}`).join(', '));
      
      // Process each script to find and fix the problematic calls
      for (const script of scripts) {
        const scriptContent = script.content;
        let needsFix = false;
        
        // Check if any problematic functions are in this script
        for (const func of functionData) {
          const fullName = `${func.objectName}.${func.functionName}`;
          if (scriptContent.includes(fullName)) {
            needsFix = true;
            
            // Find line numbers where this function is called
            const lines = scriptContent.split('\n');
            const problemLines = [];
            
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(fullName)) {
                problemLines.push({
                  lineNumber: i + 1,
                  content: lines[i].trim(),
                  functionCall: fullName
                });
              }
            }
            
            if (problemLines.length > 0) {
              console.log(`Found calls to ${fullName} on lines: ${problemLines.map(l => l.lineNumber).join(', ')}`);
              
              // Get targeted fixes using DeepSeek
              const fixes = await getTargetedFunctionFixes(scriptContent, func, problemLines);
              
              if (fixes && fixes.length > 0) {
                // Apply the patches
                let patchedScript = scriptContent;
                const scriptLines = patchedScript.split('\n');
                
                for (const fix of fixes) {
                  if (fix.startLine && fix.endLine && fix.replacement) {
                    if (fix.startLine <= scriptLines.length && fix.endLine <= scriptLines.length) {
                      // Get the indentation of the first line in the block
                      const indentation = scriptLines[fix.startLine - 1].match(/^\s*/)[0];
                      
                      // Apply the replacement with proper indentation
                      const replacementLines = fix.replacement.split('\n').map(line => indentation + line);
                      
                      // Log what we're replacing
                      console.log(`Commenting out block from line ${fix.startLine} to ${fix.endLine}:`);
                      console.log("Original:\n" + scriptLines.slice(fix.startLine - 1, fix.endLine).join('\n'));
                      console.log("Replacement:\n" + replacementLines.join('\n'));
                      
                      // Replace the block
                      scriptLines.splice(fix.startLine - 1, fix.endLine - fix.startLine + 1, ...replacementLines);
                    }
                  }
                }
                
                patchedScript = scriptLines.join('\n');
                
                // Update the HTML with the patched script
                const fixedScriptTag = script.fullMatch.replace(script.content, patchedScript);
                fixedHtml = fixedHtml.replace(script.fullMatch, fixedScriptTag);
                fixCount++;
              }
            }
          }
        }
      }
      
      return { fixedHtml, fixCount };
    } catch (error) {
      console.error('Error during function error fix:', error);
      return { fixedHtml, fixCount };
    } finally {
      // Clean up temp file
      try {
        fs.unlinkSync(tempFile);
      } catch (e) {
        // Ignore cleanup errors
      }
    }
  }
  /**
   * Get targeted fixes for specific function calls - block-aware
   * @param {string} scriptContent - The script content
   * @param {Object} functionData - Function data object
   * @param {Array} problemLines - Array of problem line objects
   * @returns {Promise<Array>} - Array of fix objects
   */
  async function getTargetedFunctionFixes(scriptContent, functionData, problemLines) {
    const fullName = `${functionData.objectName}.${functionData.functionName}`;
    
    console.log(`Getting block-aware fixes for ${fullName}...`);
    
    // Create context for each problematic line WITH block detection
    const contextBlocks = [];
    const scriptLines = scriptContent.split('\n');
    
    for (const line of problemLines) {
      // Determine block boundaries
      const blockInfo = findCodeBlock(scriptLines, line.lineNumber - 1);
      
      // Get expanded context including the entire block
      const startLine = Math.max(0, blockInfo.startLine - 3);
      const endLine = Math.min(scriptLines.length - 1, blockInfo.endLine + 3);
      
      const contextLines = scriptLines.slice(startLine, endLine + 1).map((l, i) => {
        const num = startLine + i + 1;
        const marker = num === line.lineNumber ? '>' : 
                      (num >= blockInfo.startLine + 1 && num <= blockInfo.endLine + 1) ? '*' : ' ';
        return `${marker} ${num}: ${l}`;
      }).join('\n');
      
      contextBlocks.push({
        lineNumber: line.lineNumber,
        blockStartLine: blockInfo.startLine + 1,
        blockEndLine: blockInfo.endLine + 1,
        context: contextLines,
        originalLine: scriptLines[line.lineNumber - 1],
        blockContent: scriptLines.slice(blockInfo.startLine, blockInfo.endLine + 1).join('\n')
      });
    }
    
    // Prepare prompt for DeepSeek with BLOCK-AWARE instructions
    const prompt = `I need to fix "${fullName} is not a function" errors by commenting out ENTIRE CODE BLOCKS.
    
  Here are the problematic blocks where this function is called:
  
  ${contextBlocks.map((block, i) => `
  OCCURRENCE ${i+1} (Line ${block.lineNumber}, inside block from line ${block.blockStartLine} to ${block.blockEndLine}):
  \`\`\`javascript
  ${block.context}
  \`\`\`
  
  The block content to comment out is:
  \`\`\`javascript
  ${block.blockContent}
  \`\`\`
  `).join('\n')}
  
  EXTREMELY IMPORTANT INSTRUCTIONS:
  1. DO NOT fix or replace functionality
  2. COMMENT OUT THE ENTIRE CODE BLOCK for each occurrence
  3. For each block, create a single replacement that:
     - Comments out EVERY line in the block
     - Preserves indentation
     - Adds a first comment line explaining what was commented out
  4. Maintain syntactic correctness - DO NOT leave unmatched braces or parentheses
  5. If a function call is part of a larger statement or within callbacks, comment the ENTIRE block
  
  For each block to replace, provide:
  1. The start line number
  2. The end line number 
  3. The complete replacement with ALL LINES commented
  
  Format your response as JSON:
  [
    {
      "startLine": 123,
      "endLine": 128,
      "replacement": "    // ERROR: Block commented out due to missing function ${fullName}\\n    // Original block:\\n    // line 1\\n    // line 2\\n    // etc."
    }
  ]
  
  ONLY return the JSON array with no additional text.`;
  
    try {
      // Call DeepSeek API
      const response = await axios.post(DEEPSEEK_API_URL, {
        model: 'deepseek-chat',
        messages: [
          {
            role: 'system',
            content: 'You are instructed to comment out entire code blocks containing problematic function calls. You preserve indentation and maintain syntactic correctness by commenting out all lines in the blocks, not just individual lines.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        max_tokens: 1024,
        temperature: 0.1
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${DEEPSEEK_API_KEY}`
        }
      });
  
      // Extract just the JSON from the response
      const aiResponse = response.data.choices[0].message.content;
      
      // Parse the JSON
      let fixes;
      try {
        // Try to find JSON array in the response
        const jsonMatch = aiResponse.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonMatch) {
          fixes = JSON.parse(jsonMatch[0]);
        } else {
          // If no JSON array found, try to extract from code blocks
          const codeBlockMatch = aiResponse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
          if (codeBlockMatch && codeBlockMatch[1]) {
            fixes = JSON.parse(codeBlockMatch[1].trim());
          } else {
            console.log("Couldn't extract JSON from AI response, falling back to manual fix");
            
            // Fallback to manually commenting out entire blocks
            fixes = contextBlocks.map(block => {
              const blockLines = block.blockContent.split('\n');
              const commentedLines = blockLines.map(line => `// ${line}`);
              const replacementBlock = `// ERROR: Block commented out due to missing function ${fullName}\n${commentedLines.join('\n')}`;
              
              return {
                startLine: block.blockStartLine,
                endLine: block.blockEndLine,
                replacement: replacementBlock
              };
            });
          }
        }
      } catch (e) {
        console.error("Error parsing AI response:", e);
        console.log("AI response was:", aiResponse);
        
        // Fallback to manually commenting out entire blocks
        fixes = contextBlocks.map(block => {
          const blockLines = block.blockContent.split('\n');
          const commentedLines = blockLines.map(line => `// ${line}`);
          const replacementBlock = `// ERROR: Block commented out due to missing function ${fullName}\n${commentedLines.join('\n')}`;
          
          return {
            startLine: block.blockStartLine,
            endLine: block.blockEndLine,
            replacement: replacementBlock
          };
        });
      }
      
      // SAFETY CHECK: Make sure all lines in all fixes are commented
      const validFixes = fixes.filter(fix => {
        const lines = fix.replacement.split('\n');
        return lines.every(line => line.trim().startsWith('//'));
      });
      
      if (validFixes.length !== fixes.length) {
        console.warn("Some AI-suggested block fixes weren't properly commented - using only the safe ones");
      }
      
      return validFixes;
    } catch (error) {
      console.error('Error getting block fixes:', error);
      
      // Fallback to manually commenting out entire blocks
      return contextBlocks.map(block => {
        const blockLines = block.blockContent.split('\n');
        const commentedLines = blockLines.map(line => `// ${line}`);
        const replacementBlock = `// ERROR: Block commented out due to missing function ${fullName}\n${commentedLines.join('\n')}`;
        
        return {
          startLine: block.blockStartLine,
          endLine: block.blockEndLine,
          replacement: replacementBlock
        };
      });
    }
  }
  
  /**
   * Find the boundaries of a code block containing a given line
   * @param {Array} lines - Array of code lines
   * @param {number} problematicLineIdx - Index of the problematic line
   * @returns {Object} - Object with startLine and endLine indices
   */
  function findCodeBlock(lines, problematicLineIdx) {
    // Start with reasonable defaults
    let startLine = problematicLineIdx;
    let endLine = problematicLineIdx;
    
    // Check if this line is part of a larger statement
    // First check for continuations of a previous line
    for (let i = problematicLineIdx - 1; i >= 0; i--) {
      const line = lines[i].trim();
      // Look for line continuations or openings of blocks
      if (line.endsWith('(') || line.endsWith('{') || line.endsWith('.') || 
          line.endsWith('=>') || line.endsWith('&&') || line.endsWith('||') ||
          line.endsWith('?') || line.endsWith(':')) {
        startLine = i;
      } else {
        // If we've found the beginning of the statement, check if it's a statement start
        const prevLine = lines[i].trim();
        if (prevLine.includes('if ') || prevLine.includes('for ') || 
            prevLine.includes('while ') || prevLine.includes('function ') ||
            prevLine.includes(' => ') || prevLine.includes('try ') ||
            prevLine.includes('catch ') || prevLine.includes('else ')) {
          startLine = i;
        } else {
          // Stop if we've found a line that doesn't continue
          break;
        }
      }
    }
    
    // Count brackets to find end of block
    const combinedLines = lines.slice(startLine, problematicLineIdx + 1).join('\n');
    let openBrackets = (combinedLines.match(/\{/g) || []).length;
    let closeBrackets = (combinedLines.match(/\}/g) || []).length;
    let openParens = (combinedLines.match(/\(/g) || []).length;
    let closeParens = (combinedLines.match(/\)/g) || []).length;
    
    // Find the end of the block by matching brackets/parentheses
    if (openBrackets > closeBrackets || openParens > closeParens) {
      for (let i = problematicLineIdx + 1; i < lines.length; i++) {
        const line = lines[i];
        
        // Count brackets in this line
        const lineBracketOpen = (line.match(/\{/g) || []).length;
        const lineBracketClose = (line.match(/\}/g) || []).length;
        const lineParenOpen = (line.match(/\(/g) || []).length;
        const lineParenClose = (line.match(/\)/g) || []).length;
        
        openBrackets += lineBracketOpen;
        closeBrackets += lineBracketClose;
        openParens += lineParenOpen;
        closeParens += lineParenClose;
        
        endLine = i;
        
        // If brackets balance, we've found the end of the block
        if (openBrackets === closeBrackets && openParens === closeParens) {
          break;
        }
      }
    }
    
    // Handle special case: function calls on a single line
    if (startLine === endLine) {
      const line = lines[problematicLineIdx].trim();
      if (line.includes('(') && line.includes(')')) {
        // Find statement boundaries for single-line statements
        let statementStart = problematicLineIdx;
        let statementEnd = problematicLineIdx;
        
        // Look for statement start
        for (let i = problematicLineIdx; i >= 0; i--) {
          if (lines[i].trim().endsWith(';') || lines[i].trim().endsWith('{')) {
            statementStart = i + 1;
            break;
          }
        }
        
        // Look for statement end
        for (let i = problematicLineIdx; i < lines.length; i++) {
          if (lines[i].trim().endsWith(';') || lines[i].trim().endsWith('}')) {
            statementEnd = i;
            break;
          }
        }
        
        startLine = statementStart;
        endLine = statementEnd;
      }
    }
    
    return { startLine, endLine };
  }
  
  /**
   * Extract function details from error objects with pattern matching
   * @param {Array} errorDetails - Array of error detail objects
   * @returns {Array} - Array of function data objects
   */
  function extractFunctionDetailsFromErrors(errorDetails) {
    const functionData = [];
    const seen = new Set();
    
    for (const error of errorDetails) {
      // Process various error message formats
      let matches = [];
      
      // Standard pattern
      const stdPattern = /(?:TypeError: )?([a-zA-Z0-9_$.]+)(?:\.([a-zA-Z0-9_$]+))? is not a function/i;
      const stdMatch = error.message.match(stdPattern);
      
      if (stdMatch) {
        if (stdMatch[2]) { // object.method format
          matches.push({
            objectName: stdMatch[1],
            functionName: stdMatch[2]
          });
        } else { // just function format
          matches.push({
            objectName: 'window',
            functionName: stdMatch[1]
          });
        }
      }
      
      // Stack trace format
      const stackPattern = /(?:SES_UNCAUGHT_EXCEPTION: )?TypeError: ([a-zA-Z0-9_$.]+)\.([a-zA-Z0-9_$]+) is not a function/i;
      const stackMatch = error.message.match(stackPattern);
      
      if (stackMatch) {
        matches.push({
          objectName: stackMatch[1],
          functionName: stackMatch[2]
        });
      }
      
      // Generic "X.Y is not a function" pattern
      const genericPattern = /([a-zA-Z0-9_$.]+)\.([a-zA-Z0-9_$]+)(?:\(\))? is not (?:a )?function/gi;
      let genericMatch;
      
      while ((genericMatch = genericPattern.exec(error.message)) !== null) {
        matches.push({
          objectName: genericMatch[1],
          functionName: genericMatch[2]
        });
      }
      
      // Add unique matches to our result set
      for (const match of matches) {
        const key = `${match.objectName}.${match.functionName}`;
        if (!seen.has(key)) {
          seen.add(key);
          functionData.push(match);
        }
      }
    }
    
    return functionData;
  }
  

// Update the main processHtmlFile function to include the new fixer
async function processHtmlFile(filePath) {
    const original = fs.readFileSync(filePath, 'utf8');
    const backupPath = `${filePath}.backup`;
    fs.writeFileSync(backupPath, original);
    console.log(`📦 Backup created at: ${backupPath}`);
    
    // First, fix malformed HTML tags (including script and title tags)
    console.log('Checking for malformed HTML tags...');
    const malformedTagFixResult = fixMalformedHtmlTags(original);
    let currentHtml = malformedTagFixResult.fixedHtml;
    let totalFixes = malformedTagFixResult.fixCount;

   
    // Next, fix missing style tags
    console.log('Checking for CSS not wrapped in style tags...');
    const missingStyleTagsResult = fixMissingStyleTags(currentHtml);
    currentHtml = missingStyleTagsResult.fixedHtml;
    totalFixes += missingStyleTagsResult.fixCount;
    
    // Then, fix CDN imports
    console.log('Checking for incorrect CDN imports...');
    const cdnFixResult = await fixCdnImports(currentHtml);
    currentHtml = cdnFixResult.fixedHtml;
    totalFixes += cdnFixResult.fixCount;

    console.log('Checking for "is not a function" TypeErrors...');
    const notAFunctionResult = await fixNotAFunctionErrors(currentHtml);
    currentHtml = notAFunctionResult.fixedHtml;
    totalFixes += notAFunctionResult.fixCount;
    
    // Then, fix CSS in style tags
    console.log('Checking for CSS issues in style tags...');
    const cssFixResult = await fixCssStyles(currentHtml);
    currentHtml = cssFixResult.fixedHtml;
    totalFixes += cssFixResult.fixCount;
    
    // Fix undefined variable errors
    console.log('Checking for undefined variable errors...');
    const undefinedVarResult = await fixUndefinedVariables(currentHtml);
    currentHtml = undefinedVarResult.fixedHtml;
    totalFixes += undefinedVarResult.fixCount;
    
    // Finally, fix script issues like parenthesis
    console.log('Checking for parenthesis issues in scripts...');
    const scriptFixResult = await extractAndFixScripts(currentHtml);
    currentHtml = scriptFixResult.fixedHtml;
    totalFixes += scriptFixResult.totalFixes;

    if (containsShaderMaterial(currentHtml)) {
      console.log('Detected THREE.ShaderMaterial - checking for shader compilation errors...');
      const shaderFixResult = await fixShaderMaterialErrors(currentHtml);
      currentHtml = shaderFixResult.fixedHtml;
      totalFixes += shaderFixResult.fixCount;
      
      // If shader fixes were applied, skip other preprocessing steps that might interfere
      if (shaderFixResult.fixCount > 0) {
          console.log('ShaderMaterial fixes applied - skipping other preprocessing to avoid conflicts');
          
          if (totalFixes > 0) {
              fs.writeFileSync(filePath, currentHtml, 'utf8');
              console.log(`✅ Fixed ${totalFixes} shader issues in ${filePath}`);
          }
      }
  }
    
    
    if (totalFixes > 0) {
        fs.writeFileSync(filePath, currentHtml, 'utf8');
        console.log(`✅ Fixed ${totalFixes} issues in ${filePath} (${malformedTagFixResult.fixCount} malformed tags, ${cssFixResult.fixCount} CSS issues, ${undefinedVarResult.fixCount} undefined variables, ${scriptFixResult.totalFixes} parenthesis issues)`);
    } else {
        console.log(`✅ No issues found in ${filePath}`);
    }
    
    return totalFixes;
}

// CLI Entry
if (require.main === module) {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: node p5-repair.js <html-file>');
    process.exit(1);
  }
  
  try {
    processHtmlFile(file).then(count => {
      process.exit(count > 0 ? 0 : 1);
    });
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { processHtmlFile };