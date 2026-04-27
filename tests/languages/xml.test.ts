import { describe, it, expect } from 'vitest';
import { XmlLanguagePlugin } from '../../src/indexer/plugins/language/xml/index.js';

const plugin = new XmlLanguagePlugin();

function parse(source: string, filePath = 'config.xml') {
  const result = plugin.extractSymbols(filePath, Buffer.from(source));
  expect(result.isOk()).toBe(true);
  return result._unsafeUnwrap();
}

describe('XmlLanguagePlugin', () => {
  // ── Manifest ──

  it('has correct manifest', () => {
    expect(plugin.manifest.name).toBe('xml-language');
    expect(plugin.supportedExtensions).toContain('.xml');
    expect(plugin.supportedExtensions).toContain('.xsd');
    expect(plugin.supportedExtensions).toContain('.svg');
    expect(plugin.supportedExtensions).toContain('.csproj');
    expect(plugin.supportedExtensions).toContain('.plist');
  });

  // ── Generic XML ──

  describe('generic XML', () => {
    it('extracts root element only once', () => {
      const r = parse('<root>\n  <child />\n  <other />\n</root>');
      const roots = r.symbols.filter((s) => s.metadata?.xmlKind === 'rootElement');
      expect(roots).toHaveLength(1);
      expect(roots[0].name).toBe('root');
    });

    it('handles namespaced root', () => {
      const r = parse('<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" />');
      expect(r.symbols.some((s) => s.name === 'soap:Envelope' && s.kind === 'type')).toBe(true);
    });

    it('extracts id attributes', () => {
      const r = parse('<root><a id="x" /><b id="y" /></root>');
      expect(r.symbols.some((s) => s.name === 'x' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'y' && s.kind === 'constant')).toBe(true);
    });

    it('deduplicates id symbols', () => {
      const r = parse('<root><a id="dup" /><b id="dup" /></root>');
      expect(r.symbols.filter((s) => s.name === 'dup')).toHaveLength(1);
    });

    it('extracts name from structural tags, not noise', () => {
      const r = parse('<root>\n  <setting name="timeout" />\n  <input name="email" />\n</root>');
      expect(r.symbols.some((s) => s.name === 'timeout')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'email')).toBe(false);
    });

    it('extracts namespace declarations', () => {
      const r = parse('<root xmlns:ns="http://a" xmlns:xsi="http://b" />');
      expect(r.symbols.some((s) => s.name === 'ns' && s.kind === 'namespace')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'xsi' && s.kind === 'namespace')).toBe(true);
    });

    it('skips comments, CDATA, PIs', () => {
      const r = parse(
        '<?xml version="1.0"?>\n<!-- comment -->\n<root>\n  <![CDATA[<fake>]]>\n  <item id="real" />\n</root>',
      );
      expect(r.symbols.some((s) => s.name === 'root')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'real')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'xml')).toBe(false);
      expect(r.symbols.some((s) => s.name === 'fake')).toBe(false);
    });

    it('does not extract non-import hrefs', () => {
      const r = parse('<root><a href="https://example.com">link</a></root>');
      expect(r.edges ?? []).toHaveLength(0);
    });

    it('handles empty file', () => {
      const r = parse('');
      expect(r.symbols).toHaveLength(0);
    });
  });

  // ── XSD ──

  describe('XSD', () => {
    it('detects dialect from extension', () => {
      const r = parse('<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" />', 'types.xsd');
      expect(r.metadata?.xmlDialect).toBe('xsd');
    });

    it('extracts complexType, simpleType, element', () => {
      const r = parse(
        `<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
  <xs:complexType name="UserType"><xs:sequence /></xs:complexType>
  <xs:simpleType name="StatusCode"><xs:restriction base="xs:string" /></xs:simpleType>
  <xs:element name="user" type="UserType" />
</xs:schema>`,
        'types.xsd',
      );
      expect(r.symbols.some((s) => s.name === 'UserType' && s.kind === 'type')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'StatusCode' && s.kind === 'type')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'user' && s.kind === 'type')).toBe(true);
    });

    it('extracts xs:import schemaLocation', () => {
      const r = parse(
        '<xs:schema><xs:import schemaLocation="common.xsd" /></xs:schema>',
        'types.xsd',
      );
      expect(r.edges!.some((e) => (e.metadata as any).from === 'common.xsd')).toBe(true);
    });
  });

  // ── WSDL ──

  describe('WSDL', () => {
    it('extracts WSDL definitions', () => {
      const r = parse(
        `<definitions xmlns="http://schemas.xmlsoap.org/wsdl/">
  <message name="GetUserRequest" />
  <portType name="UserPort">
    <operation name="getUser" />
  </portType>
  <service name="UserService" />
</definitions>`,
        'service.wsdl',
      );
      expect(r.symbols.some((s) => s.name === 'GetUserRequest' && s.kind === 'type')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'UserPort' && s.kind === 'type')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'getUser' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'UserService' && s.kind === 'type')).toBe(true);
    });
  });

  // ── XSLT ──

  describe('XSLT', () => {
    it('extracts templates and variables', () => {
      const r = parse(
        `<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:variable name="title" select="'Hello'" />
  <xsl:template name="header"><h1 /></xsl:template>
  <xsl:param name="lang" />
</xsl:stylesheet>`,
        'transform.xsl',
      );
      expect(r.metadata?.xmlDialect).toBe('xslt');
      expect(r.symbols.some((s) => s.name === 'header' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'title' && s.kind === 'variable')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'lang' && s.kind === 'variable')).toBe(true);
    });

    it('extracts xsl:import/include as edges', () => {
      const r = parse(
        `<xsl:stylesheet>
  <xsl:import href="base.xsl" />
  <xsl:include href="helpers.xsl" />
</xsl:stylesheet>`,
        'main.xsl',
      );
      const modules = r.edges!.map((e) => (e.metadata as any).from);
      expect(modules).toContain('base.xsl');
      expect(modules).toContain('helpers.xsl');
    });
  });

  // ── RSS ──

  describe('RSS', () => {
    it('extracts channel title and item titles', () => {
      const r = parse(`<rss version="2.0">
  <channel>
    <title>My Blog</title>
    <item><title>First Post</title><link>https://blog.com/1</link></item>
    <item><title>Second Post</title></item>
  </channel>
</rss>`);
      expect(r.metadata?.xmlDialect).toBe('rss');
      expect(r.symbols.some((s) => s.name === 'My Blog' && s.kind === 'namespace')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'First Post' && s.kind === 'constant')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'Second Post' && s.kind === 'constant')).toBe(true);
    });
  });

  // ── Atom ──

  describe('Atom', () => {
    it('extracts entry titles', () => {
      const r = parse(`<feed xmlns="http://www.w3.org/2005/Atom">
  <title>My Feed</title>
  <entry><title>Entry One</title></entry>
</feed>`);
      expect(r.metadata?.xmlDialect).toBe('atom');
      expect(r.symbols.some((s) => s.name === 'Entry One')).toBe(true);
    });
  });

  // ── Sitemap ──

  describe('Sitemap', () => {
    it('extracts URLs from sitemap', () => {
      const r = parse(`<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/</loc></url>
  <url><loc>https://example.com/about</loc></url>
</urlset>`);
      expect(r.metadata?.xmlDialect).toBe('sitemap');
      expect(r.symbols.some((s) => s.name === 'https://example.com/')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'https://example.com/about')).toBe(true);
    });
  });

  // ── Maven POM ──

  describe('Maven POM', () => {
    it('extracts groupId and artifactId', () => {
      const r = parse(
        `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <groupId>com.example</groupId>
  <artifactId>my-app</artifactId>
  <version>1.0.0</version>
</project>`,
        'pom.xml',
      );
      expect(r.metadata?.xmlDialect).toBe('maven-pom');
      expect(r.symbols.some((s) => s.name === 'com.example' && s.kind === 'namespace')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'my-app' && s.kind === 'constant')).toBe(true);
    });
  });

  // ── .NET project files ──

  describe('.NET project files', () => {
    it('extracts PackageReference and ProjectReference', () => {
      const r = parse(
        `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
    <ProjectReference Include="../Core/Core.csproj" />
  </ItemGroup>
</Project>`,
        'MyApp.csproj',
      );
      expect(r.metadata?.xmlDialect).toBe('dotnet-project');
      expect(
        r.symbols.some((s) => s.name === 'Newtonsoft.Json' && s.metadata?.xmlKind === 'nuget'),
      ).toBe(true);
      expect(
        r.symbols.some(
          (s) => s.name === '../Core/Core.csproj' && s.metadata?.xmlKind === 'projectRef',
        ),
      ).toBe(true);
      // Also as import edges
      expect(r.edges!.some((e) => (e.metadata as any).from === 'Newtonsoft.Json')).toBe(true);
      expect(r.edges!.some((e) => (e.metadata as any).from === '../Core/Core.csproj')).toBe(true);
    });
  });

  // ── Android Manifest ──

  describe('Android Manifest', () => {
    it('extracts activities and permissions', () => {
      const r = parse(
        `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.example.app">
  <uses-permission android:name="android.permission.INTERNET" />
  <application>
    <activity android:name=".MainActivity" />
    <service android:name=".SyncService" />
  </application>
</manifest>`,
        'AndroidManifest.xml',
      );
      expect(r.metadata?.xmlDialect).toBe('android-manifest');
      expect(r.symbols.some((s) => s.name === '.MainActivity' && s.kind === 'class')).toBe(true);
      expect(r.symbols.some((s) => s.name === '.SyncService' && s.kind === 'class')).toBe(true);
      expect(
        r.symbols.some((s) => s.name === 'android.permission.INTERNET' && s.kind === 'constant'),
      ).toBe(true);
    });
  });

  // ── Spring Beans ──

  describe('Spring Beans', () => {
    it('extracts beans and properties', () => {
      const r = parse(`<beans xmlns="http://www.springframework.org/schema/beans">
  <bean id="userService" class="com.example.UserService">
    <property name="repository" ref="userRepo" />
  </bean>
</beans>`);
      expect(r.metadata?.xmlDialect).toBe('spring-beans');
      expect(r.symbols.some((s) => s.name === 'userService' && s.kind === 'class')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'com.example.UserService' && s.kind === 'type')).toBe(
        true,
      );
      expect(r.symbols.some((s) => s.name === 'repository' && s.kind === 'property')).toBe(true);
    });
  });

  // ── Java web.xml ──

  describe('web.xml', () => {
    it('extracts servlets and URL patterns', () => {
      const r = parse(
        `<web-app>
  <servlet>
    <servlet-name>MainServlet</servlet-name>
    <servlet-class>com.example.MainServlet</servlet-class>
  </servlet>
  <servlet-mapping>
    <url-pattern>/api/*</url-pattern>
  </servlet-mapping>
</web-app>`,
        'web.xml',
      );
      expect(r.metadata?.xmlDialect).toBe('web-xml');
      expect(r.symbols.some((s) => s.name === 'MainServlet' && s.kind === 'class')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'com.example.MainServlet' && s.kind === 'type')).toBe(
        true,
      );
      expect(r.symbols.some((s) => s.name === '/api/*' && s.kind === 'constant')).toBe(true);
    });
  });

  // ── Ant build.xml ──

  describe('Ant build.xml', () => {
    it('extracts targets and properties', () => {
      const r = parse(
        `<project name="myapp" default="build" xmlns:ant="http://ant.apache.org/">
  <property name="src.dir" value="src" />
  <target name="compile" depends="init" />
  <target name="build" depends="compile" />
  <macrodef name="deploy-task" />
</project>`,
        'build.xml',
      );
      expect(r.metadata?.xmlDialect).toBe('ant-build');
      expect(r.symbols.some((s) => s.name === 'compile' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'build' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'src.dir' && s.kind === 'variable')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'deploy-task' && s.kind === 'function')).toBe(true);
    });
  });

  // ── Apple plist ──

  describe('plist', () => {
    it('extracts plist keys', () => {
      const r = parse(
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>MyApp</string>
  <key>CFBundleVersion</key>
  <string>1.0</string>
</dict>
</plist>`,
        'Info.plist',
      );
      expect(r.metadata?.xmlDialect).toBe('plist');
      expect(r.symbols.some((s) => s.name === 'CFBundleName' && s.kind === 'property')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'CFBundleVersion' && s.kind === 'property')).toBe(
        true,
      );
    });
  });

  // ── SVG ──

  describe('SVG', () => {
    it('extracts defs and elements with ids', () => {
      const r = parse(
        `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <linearGradient id="grad1" />
    <clipPath id="clip1" />
  </defs>
  <g id="layer1"><rect id="bg" /></g>
</svg>`,
        'icon.svg',
      );
      expect(r.metadata?.xmlDialect).toBe('svg');
      expect(r.symbols.some((s) => s.name === 'grad1')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'clip1')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'layer1')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'bg')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'xlink' && s.kind === 'namespace')).toBe(true);
    });
  });

  // ── Logback ──

  describe('Logback', () => {
    it('extracts appenders and loggers', () => {
      const r = parse(
        `<configuration>
  <appender name="STDOUT" class="ch.qos.logback.core.ConsoleAppender" />
  <logger name="com.example" level="DEBUG" />
  <root level="INFO" />
</configuration>`,
        'logback.xml',
      );
      expect(r.metadata?.xmlDialect).toBe('logback');
      expect(
        r.symbols.some((s) => s.name === 'STDOUT' && s.metadata?.xmlKind === 'logAppender'),
      ).toBe(true);
      expect(
        r.symbols.some((s) => s.name === 'com.example' && s.metadata?.xmlKind === 'logLogger'),
      ).toBe(true);
    });
  });

  // ── Struts ──

  describe('Struts', () => {
    it('extracts actions and packages', () => {
      const r = parse(
        `<struts>
  <package name="default" extends="struts-default">
    <action name="login" class="com.example.LoginAction">
      <result name="success">/login.jsp</result>
    </action>
  </package>
</struts>`,
        'struts.xml',
      );
      expect(r.metadata?.xmlDialect).toBe('struts');
      expect(r.symbols.some((s) => s.name === 'default' && s.kind === 'namespace')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'login' && s.kind === 'function')).toBe(true);
      expect(r.symbols.some((s) => s.name === 'success' && s.kind === 'constant')).toBe(true);
    });
  });

  // ── Import edges ──

  describe('import edges', () => {
    it('extracts script src', () => {
      const r = parse('<root><script src="app.js" /></root>');
      expect(r.edges!.some((e) => (e.metadata as any).from === 'app.js')).toBe(true);
    });

    it('extracts stylesheet link', () => {
      const r = parse('<root><link rel="stylesheet" href="style.css" /></root>');
      expect(r.edges!.some((e) => (e.metadata as any).from === 'style.css')).toBe(true);
    });

    it('does not extract anchor href as import', () => {
      const r = parse('<root><a href="https://example.com">link</a></root>');
      expect(r.edges ?? []).toHaveLength(0);
    });
  });

  // ── Performance ──

  it('handles 1000 elements under 500ms', () => {
    const items = Array.from(
      { length: 1000 },
      (_, i) => `  <item id="item${i}" name="n${i}" />`,
    ).join('\n');
    const start = performance.now();
    const r = parse(`<root>\n${items}\n</root>`);
    expect(performance.now() - start).toBeLessThan(500);
    expect(r.symbols.length).toBeGreaterThanOrEqual(1000);
  });
});
